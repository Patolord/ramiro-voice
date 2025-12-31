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

    // Use the new v3 streaming token endpoint (GET with query params)
    const url = new URL("https://streaming.assemblyai.com/v3/token");
    url.searchParams.set("expires_in_seconds", "3600"); // 1 hour token
    
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get streaming token: ${error}`);
    }

    const data = await response.json();
    return { token: data.token };
  },
});
