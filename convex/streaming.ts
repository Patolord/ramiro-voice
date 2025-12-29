"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { AssemblyAI } from "assemblyai";

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

    const client = new AssemblyAI({ apiKey });
    const token = await client.realtime.createTemporaryToken({ expires_in: 3600 });

    return { token };
  },
});

