import { v } from "convex/values";
import { internal } from "./_generated/api";
import { workflow } from "./index";

/**
 * Workflow to process transcription and generate insights
 * This workflow runs after a recording is finished
 */
export const processRecordingWorkflow = workflow.define({
  args: {
    recordingId: v.id("recordings"),
    transcription: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Step 1: Update recording status to processing
    await ctx.runMutation(internal.recordings.updateStatus, {
      recordingId: args.recordingId,
      status: "processing",
    });

    try {
      // Step 2: Generate insights from transcription
      const insightsResult = await ctx.runAction(
        internal.insights.generateInsights,
        {
          transcription: args.transcription,
          recordingId: args.recordingId,
        },
        // Retry on transient errors
        { retry: true }
      );

      // Step 3: Update recording with insights and mark as completed
      await ctx.runMutation(internal.recordings.updateWithInsights, {
        recordingId: args.recordingId,
        insights: insightsResult.insights,
        status: "completed",
      });
    } catch (error) {
      // If insights generation fails, still mark as completed with error
      await ctx.runMutation(internal.recordings.updateStatus, {
        recordingId: args.recordingId,
        status: "error",
        errorMessage: error instanceof Error ? error.message : "Failed to generate insights",
      });
    }

    return null;
  },
});

