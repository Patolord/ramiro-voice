"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * Generate insights from a chiropractic consultation transcription
 * This is a minimal MVP implementation that extracts key information
 */
export const generateInsights = internalAction({
  args: {
    transcription: v.string(),
    recordingId: v.id("recordings"),
  },
  returns: v.object({
    insights: v.string(),
  }),
  handler: async (ctx, args) => {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error("AssemblyAI API key not configured");
    }

    // Use AssemblyAI's LeMUR API for summarization and insights
    // This is a simple MVP approach - you can enhance this later
    const response = await fetch("https://api.assemblyai.com/lemur/v3/generate", {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript_ids: [], // We'll use the transcript text directly
        transcript_text: args.transcription,
        prompt: `You are analyzing a chiropractic consultation transcript. Extract and summarize:
1. Patient's main complaints and symptoms
2. Key observations from the physical examination
3. Treatment plan discussed
4. Follow-up recommendations
5. Any important notes or concerns

Format the response as a clear, structured summary suitable for a chiropractic clinic's records.`,
        final_model: "anthropic/claude-3-5-sonnet",
        max_output_size: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to generate insights: ${error}`);
    }

    const data = await response.json();
    return {
      insights: data.response || "Insights generation completed.",
    };
  },
});

