import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// Create a new recording entry
export const createRecording = mutation({
  args: {
    title: v.string(),
  },
  returns: v.id("recordings"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("recordings", {
      title: args.title,
      duration: 0,
      status: "recording" as const,
      transcription: "",
    });
    return id;
  },
});

// Update transcription in real-time
export const appendTranscription = mutation({
  args: {
    recordingId: v.id("recordings"),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recording = await ctx.db.get(args.recordingId);
    if (!recording) return null;

    await ctx.db.patch(args.recordingId, {
      transcription: args.text,
    });
    return null;
  },
});

// Finish recording
export const finishRecording = mutation({
  args: {
    recordingId: v.id("recordings"),
    duration: v.number(),
    finalTranscription: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.recordingId, {
      duration: args.duration,
      transcription: args.finalTranscription,
      status: "completed" as const,
    });
    return null;
  },
});

// Get a single recording
export const getRecording = query({
  args: {
    recordingId: v.id("recordings"),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("recordings"),
      _creationTime: v.number(),
      title: v.string(),
      duration: v.number(),
      status: v.union(
        v.literal("recording"),
        v.literal("completed"),
        v.literal("error")
      ),
      transcription: v.optional(v.string()),
      errorMessage: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const recording = await ctx.db.get(args.recordingId);
    if (!recording) return null;

    return {
      _id: recording._id,
      _creationTime: recording._creationTime,
      title: recording.title,
      duration: recording.duration,
      status: recording.status,
      transcription: recording.transcription,
      errorMessage: recording.errorMessage,
    };
  },
});

// List all recordings
export const listRecordings = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("recordings"),
      _creationTime: v.number(),
      title: v.string(),
      duration: v.number(),
      status: v.union(
        v.literal("recording"),
        v.literal("completed"),
        v.literal("error")
      ),
    })
  ),
  handler: async (ctx) => {
    const recordings = await ctx.db.query("recordings").order("desc").take(50);
    return recordings.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      title: r.title,
      duration: r.duration,
      status: r.status,
    }));
  },
});
