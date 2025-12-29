import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  recordings: defineTable({
    title: v.string(),
    duration: v.number(),
    status: v.union(
      v.literal("recording"),
      v.literal("completed"),
      v.literal("error")
    ),
    transcription: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  }),
});
