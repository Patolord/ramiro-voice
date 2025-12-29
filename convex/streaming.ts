"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";

// Get a temporary token for real-time streaming (keeps API key secure)
// Using the new v3 Universal Streaming API
export const getStreamingToken = action({
  args: {},
  returns: v.object({
    token: v.string(),
  }),
  handler: async () => {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error("AssemblyAI API key not configured");
    }

    // Use the new v3 streaming token endpoint
    const response = await fetch("https://api.assemblyai.com/v3/streaming/token", {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_in: 3600,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get streaming token: ${error}`);
    }

    const data = await response.json();
    return { token: data.token };
  },
});
