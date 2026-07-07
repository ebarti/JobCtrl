import { JobCtlApiClient } from "@jobctl/api-client";
import type {
  ContactCreateRequest,
  ContactDeleteRequest,
  ContactImportRequest,
  ContactListQuery,
  ContactUpdateRequest,
  ConfirmContactCandidateRequest,
  ContactResearchListQuery,
  RunContactResearchRequest,
} from "@jobctl/contracts";
import type { ApiClientPort } from "../../ports/ApiClientPort.js";

export class FetchApiClientAdapter implements ApiClientPort {
  private readonly client: JobCtlApiClient;

  constructor(baseUrl?: string) {
    this.client = new JobCtlApiClient(baseUrl);
  }

  health(): ReturnType<JobCtlApiClient["health"]> {
    return this.client.health();
  }
  dashboardSummary() {
    return this.client.dashboardSummary();
  }
  outcomeAnalytics() {
    return this.client.outcomeAnalytics();
  }
  digest() {
    return this.client.digest();
  }
  acknowledgeDigest(body?: Parameters<JobCtlApiClient["acknowledgeDigest"]>[0]) {
    return this.client.acknowledgeDigest(body);
  }
  activity(query: Parameters<JobCtlApiClient["activity"]>[0] = {}) {
    return this.client.activity(query);
  }
  activityEvent(eventId: string) {
    return this.client.activityEvent(eventId);
  }
  discoverySettings() {
    return this.client.discoverySettings();
  }
  updateDiscoverySettings(body: Parameters<JobCtlApiClient["updateDiscoverySettings"]>[0]) {
    return this.client.updateDiscoverySettings(body);
  }
  discoverySources() {
    return this.client.discoverySources();
  }
  upsertDiscoverySource(body: Parameters<JobCtlApiClient["upsertDiscoverySource"]>[0]) {
    return this.client.upsertDiscoverySource(body);
  }
  patchDiscoverySourceState(
    sourceId: string,
    body: Parameters<JobCtlApiClient["patchDiscoverySourceState"]>[1],
  ) {
    return this.client.patchDiscoverySourceState(sourceId, body);
  }
  discoverySourcePreview(sourceId: string) {
    return this.client.discoverySourcePreview(sourceId);
  }
  compensationSources() {
    return this.client.compensationSources();
  }
  discoveryLocatorCandidates() {
    return this.client.discoveryLocatorCandidates();
  }
  promoteSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobCtlApiClient["promoteSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.promoteSourceLocatorCandidate(candidateId, body);
  }
  rejectSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobCtlApiClient["rejectSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.rejectSourceLocatorCandidate(candidateId, body);
  }
  discoveryQuarantine() {
    return this.client.discoveryQuarantine();
  }
  decideDiscoveryQuarantine(
    jobKey: string,
    body: Parameters<JobCtlApiClient["decideDiscoveryQuarantine"]>[1],
  ) {
    return this.client.decideDiscoveryQuarantine(jobKey, body);
  }
  manualCaptureQueue() {
    return this.client.manualCaptureQueue();
  }
  importManualCapture(itemId: string, body: Parameters<JobCtlApiClient["importManualCapture"]>[1]) {
    return this.client.importManualCapture(itemId, body);
  }
  dismissManualCapture(
    itemId: string,
    body: Parameters<JobCtlApiClient["dismissManualCapture"]>[1] = {},
  ) {
    return this.client.dismissManualCapture(itemId, body);
  }
  recordDiscoveryFeedback(body: Parameters<JobCtlApiClient["recordDiscoveryFeedback"]>[0]) {
    return this.client.recordDiscoveryFeedback(body);
  }
  roleMatchFeedbackSuggestions() {
    return this.client.roleMatchFeedbackSuggestions();
  }
  decideRoleMatchFeedbackSuggestion(
    suggestionId: string,
    body: Parameters<JobCtlApiClient["decideRoleMatchFeedbackSuggestion"]>[1],
  ) {
    return this.client.decideRoleMatchFeedbackSuggestion(suggestionId, body);
  }
  applyReviewQueue() {
    return this.client.applyReviewQueue();
  }
  decideApplyReview(
    jobKey: string,
    body: Parameters<JobCtlApiClient["decideApplyReview"]>[1],
  ) {
    return this.client.decideApplyReview(jobKey, body);
  }
  resumeReviewDraft(jobKey: string) {
    return this.client.resumeReviewDraft(jobKey);
  }
  createResumeReviewDraft(
    jobKey: string,
    body: Parameters<JobCtlApiClient["createResumeReviewDraft"]>[1] = {},
  ) {
    return this.client.createResumeReviewDraft(jobKey, body);
  }
  saveResumeReviewDraftRevision(
    draftId: string,
    body: Parameters<JobCtlApiClient["saveResumeReviewDraftRevision"]>[1],
  ) {
    return this.client.saveResumeReviewDraftRevision(draftId, body);
  }
  seedResumeReviewCommentThreads(
    draftId: string,
    body: Parameters<JobCtlApiClient["seedResumeReviewCommentThreads"]>[1],
  ) {
    return this.client.seedResumeReviewCommentThreads(draftId, body);
  }
  renderResumeReviewDraft(
    draftId: string,
    body: Parameters<JobCtlApiClient["renderResumeReviewDraft"]>[1] = {},
  ) {
    return this.client.renderResumeReviewDraft(draftId, body);
  }
  replyToResumeReviewComment(
    threadId: string,
    body: Parameters<JobCtlApiClient["replyToResumeReviewComment"]>[1],
  ) {
    return this.client.replyToResumeReviewComment(threadId, body);
  }
  resumeReviewFeedback(jobKey: string) {
    return this.client.resumeReviewFeedback(jobKey);
  }
  resumeTemplates() {
    return this.client.resumeTemplates();
  }
  resumeTemplate(templateId: string) {
    return this.client.resumeTemplate(templateId);
  }
  saveResumeTemplate(body: Parameters<JobCtlApiClient["saveResumeTemplate"]>[0]) {
    return this.client.saveResumeTemplate(body);
  }
  setDefaultResumeTemplate(body: Parameters<JobCtlApiClient["setDefaultResumeTemplate"]>[0]) {
    return this.client.setDefaultResumeTemplate(body);
  }
  setJobResumeTemplate(
    jobKey: string,
    body: Parameters<JobCtlApiClient["setJobResumeTemplate"]>[1],
  ) {
    return this.client.setJobResumeTemplate(jobKey, body);
  }
  ensureCurrentResumeMaterials(
    jobKey: string,
    body: Parameters<JobCtlApiClient["ensureCurrentResumeMaterials"]>[1] = {},
  ) {
    return this.client.ensureCurrentResumeMaterials(jobKey, body);
  }
  applicationOutcomes() {
    return this.client.applicationOutcomes();
  }
  jobApplicationOutcomes(jobKey: string) {
    return this.client.jobApplicationOutcomes(jobKey);
  }
  recordManualApplicationOutcome(
    jobKey: string,
    body: Parameters<JobCtlApiClient["recordManualApplicationOutcome"]>[1],
  ) {
    return this.client.recordManualApplicationOutcome(jobKey, body);
  }
  decideOutcomeSuggestion(
    suggestionId: string,
    body: Parameters<JobCtlApiClient["decideOutcomeSuggestion"]>[1],
  ) {
    return this.client.decideOutcomeSuggestion(suggestionId, body);
  }
  jobs(query: Parameters<JobCtlApiClient["jobs"]>[0] = {}) {
    return this.client.jobs(query);
  }
  job(jobKey: string) {
    return this.client.job(jobKey);
  }
  evidenceMap() {
    return this.client.evidenceMap();
  }
  deleteJob(jobKey: string, body: Parameters<JobCtlApiClient["deleteJob"]>[1] = {}) {
    return this.client.deleteJob(jobKey, body);
  }
  deleteJobs(body: Parameters<JobCtlApiClient["deleteJobs"]>[0]) {
    return this.client.deleteJobs(body);
  }
  permanentlyDeleteJob(jobKey: string) {
    return this.client.permanentlyDeleteJob(jobKey);
  }
  permanentlyDeleteJobs(body: Parameters<JobCtlApiClient["permanentlyDeleteJobs"]>[0]) {
    return this.client.permanentlyDeleteJobs(body);
  }
  restoreJob(jobKey: string) {
    return this.client.restoreJob(jobKey);
  }
  restoreJobs(body: Parameters<JobCtlApiClient["restoreJobs"]>[0]) {
    return this.client.restoreJobs(body);
  }
  hideJob(jobKey: string, body: Parameters<JobCtlApiClient["hideJob"]>[1] = {}) {
    return this.client.hideJob(jobKey, body);
  }
  hideJobs(body: Parameters<JobCtlApiClient["hideJobs"]>[0]) {
    return this.client.hideJobs(body);
  }
  unhideJob(jobKey: string) {
    return this.client.unhideJob(jobKey);
  }
  unhideJobs(body: Parameters<JobCtlApiClient["unhideJobs"]>[0]) {
    return this.client.unhideJobs(body);
  }
  retryFailedJobs(body: Parameters<JobCtlApiClient["retryFailedJobs"]>[0]) {
    return this.client.retryFailedJobs(body);
  }
  correctScore(jobKey: string, body: Parameters<JobCtlApiClient["correctScore"]>[1]) {
    return this.client.correctScore(jobKey, body);
  }
  resetStaleScoresForRescore(body: Parameters<JobCtlApiClient["resetStaleScoresForRescore"]>[0]) {
    return this.client.resetStaleScoresForRescore(body);
  }
  rescoreJob(jobKey: string, body: Parameters<JobCtlApiClient["rescoreJob"]>[1] = {}) {
    return this.client.rescoreJob(jobKey, body);
  }
  refreshCompensation(jobKey: string, body: Parameters<JobCtlApiClient["refreshCompensation"]>[1] = {}) {
    return this.client.refreshCompensation(jobKey, body);
  }
  refreshAllCompensation(body: Parameters<JobCtlApiClient["refreshAllCompensation"]>[0] = {}) {
    return this.client.refreshAllCompensation(body);
  }
  rescoreJobsNotOnCurrentScoringPolicy(
    body: Parameters<JobCtlApiClient["rescoreJobsNotOnCurrentScoringPolicy"]>[0],
  ) {
    return this.client.rescoreJobsNotOnCurrentScoringPolicy(body);
  }
  retailorJob(jobKey: string, body: Parameters<JobCtlApiClient["retailorJob"]>[1] = {}) {
    return this.client.retailorJob(jobKey, body);
  }
  tailorJob(jobKey: string, body: Parameters<JobCtlApiClient["tailorJob"]>[1] = {}) {
    return this.client.tailorJob(jobKey, body);
  }
  retailorCurrentPolicy(body: Parameters<JobCtlApiClient["retailorCurrentPolicy"]>[0]) {
    return this.client.retailorCurrentPolicy(body);
  }
  workflowRuns(query: Parameters<JobCtlApiClient["workflowRuns"]>[0] = {}) {
    return this.client.workflowRuns(query);
  }
  workflowRun(runId: string) {
    return this.client.workflowRun(runId);
  }
  cancelWorkflowRun(runId: string) {
    return this.client.cancelWorkflowRun(runId);
  }
  artifacts(query: Parameters<JobCtlApiClient["artifacts"]>[0] = {}) {
    return this.client.artifacts(query);
  }
  artifact(artifactId: string) {
    return this.client.artifact(artifactId);
  }
  artifactPreviewPdfUrl(artifactId: string, cacheKey?: number | string): string {
    return this.client.artifactPreviewPdfUrl(artifactId, cacheKey);
  }
  artifactPreviewHtmlUrl(artifactId: string, cacheKey?: number | string): string {
    return this.client.artifactPreviewHtmlUrl(artifactId, cacheKey);
  }
  openArtifact(artifactId: string) {
    return this.client.openArtifact(artifactId);
  }
  profile() {
    return this.client.profile();
  }
  profilePreviewPdfUrl(cacheKey?: number | string): string {
    return this.client.profilePreviewPdfUrl(cacheKey);
  }
  profilePreviewHtmlUrl(cacheKey?: number | string): string {
    return this.client.profilePreviewHtmlUrl(cacheKey);
  }
  updateProfile(body: Parameters<JobCtlApiClient["updateProfile"]>[0]) {
    return this.client.updateProfile(body);
  }
  importResume(body: Parameters<JobCtlApiClient["importResume"]>[0]) {
    return this.client.importResume(body);
  }
  settings() {
    return this.client.settings();
  }
  updateSettings(body: Parameters<JobCtlApiClient["updateSettings"]>[0]) {
    return this.client.updateSettings(body);
  }
  extensionCapabilityToken() {
    return this.client.extensionCapabilityToken();
  }
  rotateExtensionCapabilityToken() {
    return this.client.rotateExtensionCapabilityToken();
  }
  runPipelineStages(body: Parameters<JobCtlApiClient["runPipelineStages"]>[0]) {
    return this.client.runPipelineStages(body);
  }
  runPendingPreparation(body: Parameters<JobCtlApiClient["runPendingPreparation"]>[0]) {
    return this.client.runPendingPreparation(body);
  }
  credentials() {
    return this.client.credentials();
  }
  updateCredential(body: Parameters<JobCtlApiClient["updateCredential"]>[0]) {
    return this.client.updateCredential(body);
  }
  deleteCredential(key: Parameters<JobCtlApiClient["deleteCredential"]>[0]) {
    return this.client.deleteCredential(key);
  }
  retryStage(jobKey: string, body: Parameters<JobCtlApiClient["retryStage"]>[1]) {
    return this.client.retryStage(jobKey, body);
  }
  runJobStage(jobKey: string, body: Parameters<JobCtlApiClient["runJobStage"]>[1]) {
    return this.client.runJobStage(jobKey, body);
  }
  generateMaterials(jobKey: string, body: Parameters<JobCtlApiClient["generateMaterials"]>[1] = {}) {
    return this.client.generateMaterials(jobKey, body);
  }
  generateInterviewPrep(jobKey: string, body: Parameters<JobCtlApiClient["generateInterviewPrep"]>[1] = {}) {
    return this.client.generateInterviewPrep(jobKey, body);
  }
  applyJob(jobKey: string, body: Parameters<JobCtlApiClient["applyJob"]>[1] = {}) {
    return this.client.applyJob(jobKey, body);
  }
  cancelJobAction(jobKey: string, body: Parameters<JobCtlApiClient["cancelJobAction"]>[1] = {}) {
    return this.client.cancelJobAction(jobKey, body);
  }
  markApplied(jobKey: string, body: Parameters<JobCtlApiClient["markApplied"]>[1] = {}) {
    return this.client.markApplied(jobKey, body);
  }
  markSkipped(jobKey: string, body: Parameters<JobCtlApiClient["markSkipped"]>[1] = {}) {
    return this.client.markSkipped(jobKey, body);
  }

  listContacts(query: Partial<ContactListQuery> = {}) {
    return this.client.listContacts(query);
  }
  contact(contactId: string) {
    return this.client.contact(contactId);
  }
  createContact(body: ContactCreateRequest) {
    return this.client.createContact(body);
  }
  updateContact(contactId: string, body: ContactUpdateRequest) {
    return this.client.updateContact(contactId, body);
  }
  deleteContact(contactId: string, body: ContactDeleteRequest = {}) {
    return this.client.deleteContact(contactId, body);
  }
  importContacts(body: ContactImportRequest) {
    return this.client.importContacts(body);
  }
  researchTasks(query: Partial<ContactResearchListQuery> = {}) {
    return this.client.researchTasks(query);
  }
  researchTask(taskId: string) {
    return this.client.researchTask(taskId);
  }
  runContactResearch(body: RunContactResearchRequest) {
    return this.client.runContactResearch(body);
  }
  confirmContactCandidate(
    taskId: string,
    candidateId: string,
    body: ConfirmContactCandidateRequest = {},
  ) {
    return this.client.confirmContactCandidate(taskId, candidateId, body);
  }
  outreachThread(contactId: string, query: Parameters<JobCtlApiClient["outreachThread"]>[1] = {}) {
    return this.client.outreachThread(contactId, query);
  }
  generateOutreachDraft(
    contactId: string,
    body: Parameters<JobCtlApiClient["generateOutreachDraft"]>[1] = {},
  ) {
    return this.client.generateOutreachDraft(contactId, body);
  }
  reviseOutreachDraft(
    threadId: string,
    body: Parameters<JobCtlApiClient["reviseOutreachDraft"]>[1],
  ) {
    return this.client.reviseOutreachDraft(threadId, body);
  }
  approveOutreachDraft(threadId: string, draftId: string) {
    return this.client.approveOutreachDraft(threadId, draftId);
  }
  rejectOutreachDraft(
    threadId: string,
    draftId: string,
    body: Parameters<JobCtlApiClient["rejectOutreachDraft"]>[2] = {},
  ) {
    return this.client.rejectOutreachDraft(threadId, draftId, body);
  }
  logOutreachSend(
    threadId: string,
    body: Parameters<JobCtlApiClient["logOutreachSend"]>[1],
  ) {
    return this.client.logOutreachSend(threadId, body);
  }
  scheduleOutreachFollowUp(
    threadId: string,
    body: Parameters<JobCtlApiClient["scheduleOutreachFollowUp"]>[1] = {},
  ) {
    return this.client.scheduleOutreachFollowUp(threadId, body);
  }
  completeOutreachFollowUp(threadId: string) {
    return this.client.completeOutreachFollowUp(threadId);
  }
  dismissOutreachFollowUp(threadId: string) {
    return this.client.dismissOutreachFollowUp(threadId);
  }
  dueOutreachFollowUps() {
    return this.client.dueOutreachFollowUps();
  }
}
