import { ctx } from "@interval/sdk";
import SpotifyWebApi from "spotify-web-api-node";
import { getDateString, monthNames, sleep } from "./util";
import prisma from "./prisma";
import { Prisma } from "@prisma/client";
import { requireUser } from "./auth";

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// https://developer.spotify.com/documentation/general/guides/scopes/#scopes
export const spotifyScopes = [
  "user-library-read",
  "user-library-modify",
  "user-read-private",
  "user-read-recently-played",
  // "user-read-playback-position",
  // "user-read-playback-state",
  // "user-read-currently-playing",
  // "user-modify-playback-state",
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
];

// to save time in other places, we'll format all fetched tracks into this shape
export type SpotifyTrackObject = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  coverImage?: string;
  spotifyUri: string;
};

export const SPOTIFY_MAX_LIMIT = 50;

function convertTrackObjects(
  tracks: SpotifyApi.TrackObjectFull[]
): SpotifyTrackObject[] {
  return tracks.map((track) => ({
    id: track.id,
    name: track.name,
    artists: track.artists.map((a) => a.name),
    album: track.album.name,
    coverImage: track.album.images[0]?.url,
    spotifyUri: track.uri,
  }));
}

export async function collectTracksForMonth({ date }: { date: Date }) {
  const pagedTracks: SpotifyApi.SavedTrackObject[] = [];
  let page = 0;

  const month = date.getMonth();
  const year = date.getFullYear();

  const monthNameString = `${monthNames[month]} ${year}`;

  while (true) {
    ctx.log(`Fetching page ${page + 1}`);

    const liked = await spotifyApi.getMySavedTracks({
      limit: 50,
      offset: page * 50,
    });

    const lastTrackDate = new Date(liked.body.items[0].added_at);

    ctx.loading.update({ description: getDateString(lastTrackDate) });

    const items = liked.body.items.filter(
      (t) =>
        new Date(t.added_at).getMonth() === month &&
        new Date(t.added_at).getFullYear() === year
    );

    ctx.log(`- Tracks from ${monthNameString} in this page:`, items.length);

    // avoid rate limiting
    await sleep(1000);

    page++;

    if (items.length === 0) {
      if (pagedTracks.length > 0) {
        // reached the end
        break;
      }

      if (
        lastTrackDate.getMonth() < month &&
        lastTrackDate.getFullYear() < year
      ) {
        // have paged beyond the month we're searching for
        break;
      }

      continue;
    }

    pagedTracks.push(...items);
  }

  const tracksFromMonth: (Pick<
    SpotifyApi.SavedTrackObject["track"],
    "id" | "uri" | "name"
  > & {
    artists: string;
    added_at: string;
  })[] = [];

  pagedTracks.forEach(async (item) => {
    const { uri, artists, name, id } = item.track;

    tracksFromMonth.push({
      id,
      uri,
      name,
      artists: artists.map((a) => a.name).join(", "),
      added_at: item.added_at,
    });
  });

  return tracksFromMonth;
}

export async function collectTracksFromPlaylist({
  id,
}: {
  id: string;
  name?: string;
}): Promise<SpotifyApi.PlaylistTrackObject[]> {
  const allTracks: SpotifyApi.PlaylistTrackObject[] = [];
  let total = 0;
  let hasMore = true;

  ctx.loading.start("Fetching tracks from playlist...");

  while (hasMore) {
    const offset = allTracks.length;

    const tracks = await spotifyApi.getPlaylistTracks(id, {
      limit: SPOTIFY_MAX_LIMIT,
      offset,
    });

    total = tracks.body.total;

    ctx.loading.update({
      description: `Fetched ${offset + tracks.body.items.length} of ${total}`,
    });

    hasMore = tracks.body.next !== null;

    // avoid rate limiting
    await sleep(1000);

    allTracks.push(...tracks.body.items);
  }

  return allTracks;
}

export async function cachePlaylistTracks(
  playlistId: string,
  tracks: Pick<SpotifyApi.PlaylistTrackObject, "added_at" | "track">[],
  options: { isFullSync?: boolean } = {}
) {
  const { isFullSync = true } = options;

  await ctx.loading.start(`Caching ${tracks.length} tracks...`);

  const playlist = await spotifyApi.getPlaylist(playlistId);

  const { id: userId } = await requireUser();

  // sync playlist details
  await prisma.playlist.upsert({
    where: { id: playlistId },
    create: {
      id: playlistId,
      userId: userId,
      name: playlist.body.name,
      total: playlist.body.tracks.total,
    },
    update: {
      userId: userId,
      name: playlist.body.name,
      total: playlist.body.tracks.total,
    },
  });

  if (isFullSync) {
    // remove existing playlist associations
    await prisma.playlistToTrack.deleteMany({
      where: { playlistId },
    });
  }

  const tracksWithMetadata = await getAudioAnalysisForTracks(
    tracks.map((t) => t.track)
  );

  for (const { track, added_at } of tracks) {
    const metadata = tracksWithMetadata.find((t) => t.id === track.id);

    const data: Prisma.TrackCreateInput = {
      id: track.id,
      name: track.name,
      artistsString: track.artists.map((a) => a.name).join(", "),
      spotifyUri: track.uri,
      album: track.album.name,
      imageUrl: track.album.images[0]?.url,
      duration: metadata?.duration,
      key: metadata?.key,
      tempo: metadata?.tempo,
    };

    await prisma.track.upsert({
      where: { id: track.id },
      create: data,
      update: data,
    });

    await prisma.playlistToTrack.upsert({
      where: {
        playlistId_trackId: { playlistId, trackId: track.id },
      },
      create: {
        playlistId,
        trackId: track.id,
        createdAt: new Date(added_at),
        updatedAt: new Date(added_at),
      },
      update: {
        createdAt: new Date(added_at),
        updatedAt: new Date(added_at),
      },
    });
  }
}

export async function collectAndCachePlaylistTracks(playlist: {
  id: string;
  name?: string;
}) {
  const tracks = await collectTracksFromPlaylist(playlist);
  await cachePlaylistTracks(playlist.id, tracks);
}

export async function getAudioAnalysisForTracks<
  T extends SpotifyApi.TrackObjectSimplified
>(
  tracks: T[]
): Promise<
  (T & {
    tempo?: number;
    key?: number;
    duration?: number;
  })[]
> {
  const trackIds = tracks.map((track) => track.id);

  const audioAnalysis: SpotifyApi.AudioFeaturesObject[] = [];

  // collect in batches of 100
  for (let i = 0; i < trackIds.length; i += 100) {
    const ids = trackIds.slice(i, i + 100);

    const analysis = await spotifyApi.getAudioFeaturesForTracks(ids);

    audioAnalysis.push(...analysis.body.audio_features);
  }

  return tracks.map((t) => ({
    ...t,
    tempo: audioAnalysis.find((a) => a.id === t.id)?.tempo,
    key: audioAnalysis.find((a) => a.id === t.id)?.key,
    duration: audioAnalysis.find((a) => a.id === t.id)?.duration_ms,
  }));
}

export async function collectPlaylists({ cache = false }: { cache?: boolean }) {
  const items: SpotifyApi.PlaylistObjectSimplified[] = [];
  let total = 0;
  let offset = 0;
  let hasMore = true;

  ctx.loading.start("Fetching playlists...");

  const { id: userId } = await requireUser();

  while (hasMore) {
    const playlists = await spotifyApi.getUserPlaylists({
      limit: SPOTIFY_MAX_LIMIT,
      offset,
    });

    offset += playlists.body.items.length;
    total = playlists.body.total;

    ctx.loading.update({ description: `Fetched ${offset} of ${total}` });

    hasMore = playlists.body.next !== null;

    const selfPlaylists = playlists.body.items.filter(
      (playlist) => playlist.owner.id === userId
    );

    items.push(...selfPlaylists);

    // avoid rate limiting
    await sleep(1000);
  }

  if (cache) {
    ctx.loading.update({ description: `Caching data...` });

    for (const playlist of items) {
      await prisma.playlist.upsert({
        where: { id: playlist.id },
        update: {
          userId: userId,
          name: playlist.name,
          public: playlist.public,
          collaborative: playlist.collaborative,
          total: playlist.tracks.total,
          description: playlist.description,
        },
        create: {
          id: playlist.id,
          userId: userId,
          name: playlist.name,
          public: playlist.public,
          collaborative: playlist.collaborative,
          total: playlist.tracks.total,
          description: playlist.description,
        },
      });
    }
  }

  return items;
}

export default spotifyApi;
