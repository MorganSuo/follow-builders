#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs daily (via GitHub Actions) to fetch content from all sources and
// publish a single feed.json that any user's agent can consume.
//
// This means users need ZERO API keys — all fetching is done centrally.
//
// Sources:
//   - X/Twitter: Official API v2 (paid by the skill maintainer)
//   - YouTube: Supadata API (paid by the skill maintainer)
//
// Output: feed.json with all content, ready for agents to remix
//
// Usage: node generate-feed.js
// Env vars needed: X_BEARER_TOKEN, SUPADATA_API_KEY
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const X_API_BASE = 'https://api.x.com/2';

// How far back to look for content
const LOOKBACK_HOURS = 24;

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const sourcesPath = join(scriptDir, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

async function fetchYouTubeContent(podcasts, apiKey, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const podcast of podcasts) {
    try {
      // Get recent video IDs
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      // Check the first 3 videos for recency
      for (const videoId of videoIds.slice(0, 3)) {
        try {
          // Get metadata
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );

          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          // Skip videos older than our lookback
          if (publishedAt && new Date(publishedAt) < cutoff) continue;

          // Fetch transcript
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          const transcriptRes = await fetch(
            `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
            { headers: { 'x-api-key': apiKey } }
          );

          if (!transcriptRes.ok) {
            errors.push(`YouTube: Failed to get transcript for ${videoId}: HTTP ${transcriptRes.status}`);
            continue;
          }

          const transcriptData = await transcriptRes.json();

          results.push({
            source: 'podcast',
            name: podcast.name,
            title: meta.title || 'Untitled',
            videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            publishedAt,
            transcript: transcriptData.content || ''
          });

          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`YouTube: Error processing video ${videoId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  return results;
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Step 1: Look up all user IDs in a single batch (up to 100 usernames)
  // This uses 1 API call instead of 32
  const handles = xAccounts.map(a => a.handle);
  const handleToName = {};
  xAccounts.forEach(a => { handleToName[a.handle.toLowerCase()] = a.name; });

  let userMap = {}; // handle -> userId

  // X API allows up to 100 usernames per lookup
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }

      // Log any users not found
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Step 2: Fetch recent tweets for each user
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=10` +
        `&tweet.fields=created_at,public_metrics,referenced_tweets,entities` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        // 429 = rate limited, back off
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const tweets = data.data || [];

      if (tweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        // Include the user's current bio so agents can describe them accurately
        bio: userData.description,
        tweets: tweets.map(t => ({
          id: t.id,
          text: t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          // If this is a quote tweet, note what it's quoting
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
        }))
      });

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const xBearerToken = process.env.X_BEARER_TOKEN;
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!xBearerToken) {
    console.error('X_BEARER_TOKEN not set');
    process.exit(1);
  }
  if (!supadataKey) {
    console.error('SUPADATA_API_KEY not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const errors = [];

  console.error('Fetching YouTube content...');
  const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, errors);
  console.error(`  Found ${podcasts.length} new episodes`);

  console.error('Fetching X/Twitter content...');
  const xContent = await fetchXContent(sources.x_accounts, xBearerToken, errors);
  console.error(`  Found ${xContent.length} builders with new tweets`);

  // Build the feed
  const feed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    podcasts,
    x: xContent,
    stats: {
      podcastEpisodes: podcasts.length,
      xBuilders: xContent.length,
      totalTweets: xContent.reduce((sum, a) => sum + a.tweets.length, 0)
    },
    errors: errors.length > 0 ? errors : undefined
  };

  // Write to feed.json in the repo root (GitHub Pages will serve this)
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const feedPath = join(scriptDir, '..', 'feed.json');
  await writeFile(feedPath, JSON.stringify(feed, null, 2));

  console.error(`\nFeed written to feed.json`);
  console.error(`  ${feed.stats.podcastEpisodes} podcast episodes`);
  console.error(`  ${feed.stats.xBuilders} builders, ${feed.stats.totalTweets} tweets`);
  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
