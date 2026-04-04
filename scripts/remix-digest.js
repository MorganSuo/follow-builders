#!/usr/bin/env node
// remix-digest.js
// Reads raw JSON from prepare-digest.js, calls MiniMax M2.7 (Anthropic-compatible API)
// to remix into a bilingual digest, outputs the final text.
//
// Usage: node prepare-digest.js | node remix-digest.js > digest.txt
//        node remix-digest.js --file /tmp/fb-raw.json > digest.txt

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import { config } from "dotenv";

// Load .env from ~/.follow-builders/
config({ path: resolve(process.env.HOME, ".follow-builders", ".env") });

const API_KEY = process.env.MINIMAX_API_KEY;
if (!API_KEY) {
  console.error("Error: MINIMAX_API_KEY not set in ~/.follow-builders/.env");
  process.exit(1);
}

const client = new Anthropic({
  apiKey: API_KEY,
  baseURL: "https://api.minimax.io/anthropic",
});

async function readInput() {
  // Check for --file flag
  const fileIdx = process.argv.indexOf("--file");
  if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    return readFileSync(process.argv[fileIdx + 1], "utf-8");
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function remix(rawJson) {
  const data = JSON.parse(rawJson);

  if (data.status !== "ok") {
    console.error("Feed data is not ok:", data.status);
    process.exit(1);
  }

  const { podcasts, x, blogs, prompts, stats, config: userConfig } = data;

  if (stats.podcastEpisodes === 0 && stats.xBuilders === 0 && (stats.blogPosts || 0) === 0) {
    console.log("No new updates from your builders today. Check back tomorrow!");
    return;
  }

  // Build the prompt for the LLM
  const language = userConfig?.language || "bilingual";

  // Prepare content sections
  let contentSections = [];

  // X/Twitter content
  if (x && x.length > 0) {
    const xContent = x
      .filter((b) => b.tweets && b.tweets.length > 0)
      .map((b) => {
        const tweetsText = b.tweets
          .map(
            (t) =>
              `- Text: ${t.text}\n  URL: ${t.url}\n  Likes: ${t.likes}, Retweets: ${t.retweets}`
          )
          .join("\n");
        return `### ${b.name} (${b.handle})\nBio: ${b.bio}\n${tweetsText}`;
      })
      .join("\n\n");
    contentSections.push(`## X/Twitter Posts\n\n${xContent}`);
  }

  // Blog content
  if (blogs && blogs.length > 0) {
    const blogContent = blogs
      .map((b) => `### ${b.name}: ${b.title}\nURL: ${b.url}\nContent: ${b.content?.substring(0, 3000) || "N/A"}`)
      .join("\n\n");
    contentSections.push(`## Blog Posts\n\n${blogContent}`);
  }

  // Podcast content - truncate transcript to fit context
  if (podcasts && podcasts.length > 0) {
    const podContent = podcasts
      .map((p) => {
        const transcript = p.transcript?.substring(0, 30000) || "N/A";
        return `### ${p.name}: ${p.title}\nURL: ${p.url}\nTranscript:\n${transcript}`;
      })
      .join("\n\n");
    contentSections.push(`## Podcasts\n\n${podContent}`);
  }

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: userConfig?.timezone || "America/Los_Angeles",
  });

  const systemPrompt = `You are an AI content curator creating a daily digest of what top AI builders are saying and building.

${prompts.digest_intro}

${prompts.summarize_tweets}

${prompts.summarize_podcast}

${prompts.summarize_blogs || ""}

TODAY'S DATE: ${today}. Use this exact date in the digest header.

LANGUAGE: ${language}
${language === "bilingual" || language === "zh" ? prompts.translate : ""}

${language === "bilingual" ? `
CRITICAL — BILINGUAL FORMAT:
You MUST output BILINGUAL content. For EVERY builder's summary:
1. Write the English version first
2. Then write the Chinese translation directly below (separated by a blank line)
3. Then move to the next builder
Do NOT output all English first then all Chinese. INTERLEAVE them paragraph by paragraph.
Same for the podcast section.
` : ""}

IMPORTANT RULES:
- Every piece of content MUST include its source URL
- NEVER fabricate content or quotes
- NEVER use @ before Twitter handles (on Telegram, @handle becomes a clickable Telegram user link)
- Skip builders with nothing substantive to report
- Keep it scannable for phone screens`;

  const userPrompt = `Here is today's raw content from AI builders. Remix it into a polished digest following the instructions above.

${contentSections.join("\n\n---\n\n")}`;

  const message = await client.messages.create({
    model: "MiniMax-M2.7",
    max_tokens: 8000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  // Extract text from response
  const digest = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  console.log(digest);
}

try {
  const input = await readInput();
  await remix(input);
} catch (err) {
  console.error("Remix failed:", err.message);
  process.exit(1);
}
