import { expectTypeOf, it } from "vitest";
import {
  InterviewPrepSchema, InterviewCatalogSchema, InterviewGenerationContextSchema,
  InterviewQuestionMetadataSchema, InterviewQuestionNoteSchema, SaveInterviewQuestionNoteRequestSchema,
} from "../../contracts/src/interview.js";
import type {
  InterviewPrep, InterviewCatalog, InterviewGenerationContext, InterviewQuestionMetadata,
  InterviewQuestionNote, SaveInterviewQuestionNoteRequest,
} from "../src/interview/index.js";

it("shares parsed wire vocabulary without another prep or note definition", () => {
  expectTypeOf<ReturnType<typeof InterviewCatalogSchema.parse>>().toEqualTypeOf<InterviewCatalog>();
  expectTypeOf<ReturnType<typeof InterviewGenerationContextSchema.parse>>().toEqualTypeOf<InterviewGenerationContext>();
  expectTypeOf<ReturnType<typeof InterviewQuestionMetadataSchema.parse>>().toEqualTypeOf<InterviewQuestionMetadata>();
  expectTypeOf<ReturnType<typeof InterviewPrepSchema.parse>>().toEqualTypeOf<InterviewPrep>();
  expectTypeOf<ReturnType<typeof InterviewQuestionNoteSchema.parse>>().toEqualTypeOf<InterviewQuestionNote>();
  expectTypeOf<ReturnType<typeof SaveInterviewQuestionNoteRequestSchema.parse>>().toEqualTypeOf<SaveInterviewQuestionNoteRequest>();
});
