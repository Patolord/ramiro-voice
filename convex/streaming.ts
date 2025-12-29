"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";

// Get a temporary token for real-time streaming (keeps API key secure)
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

    // Use the new Universal streaming API endpoint
    const response = await fetch("https://api.assemblyai.com/v2/realtime/token", {
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
