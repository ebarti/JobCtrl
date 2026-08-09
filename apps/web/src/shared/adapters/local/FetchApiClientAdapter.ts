import { createEndpointDelegates, JobCtrlApiClient } from "@jobctrl/api-client";
import type {
  ContactCreateRequest,
  ContactDeleteRequest,
  ContactImportRequest,
  ContactListQuery,
  ContactUpdateRequest,
  ConfirmContactCandidateRequest,
  ContactResearchListQuery,
  EndpointClientMethods,
  RunContactResearchRequest,
} from "@jobctrl/contracts";
import type { ApiClientPort } from "../../ports/ApiClientPort.js";

export class FetchApiClientAdapter implements ApiClientPort {
  private readonly client: JobCtrlApiClient;

  constructor(baseUrl?: string) {
    this.client = new JobCtrlApiClient(baseUrl);
    Object.assign(this, createEndpointDelegates(this.client));
  }

  health(): ReturnType<JobCtrlApiClient["health"]> {
    return this.client.health();
  }
  dashboardSummary() {
    return this.client.dashboardSummary();
  }
  pipelineOperations() {
    return this.client.pipelineOperations();
  }
  outcomeAnalytics() {
    return this.client.outcomeAnalytics();
  }
  learningRecommendationEvidence(
    recommendationId: string,
    query: Parameters<JobCtrlApiClient["learningRecommendationEvidence"]>[1] = {},
  ) {
    return this.client.learningRecommendationEvidence(recommendationId, query);
  }
  tailoringPolicyRevisions(
    query: Parameters<JobCtrlApiClient["tailoringPolicyRevisions"]>[0] = {},
  ) {
    return this.client.tailoringPolicyRevisions(query);
  }
  digest() {
    return this.client.digest();
  }
  acknowledgeDigest(body?: Parameters<JobCtrlApiClient["acknowledgeDigest"]>[0]) {
    return this.client.acknowledgeDigest(body);
  }
  activity(query: Parameters<JobCtrlApiClient["activity"]>[0] = {}) {
    return this.client.activity(query);
  }
  activityEvent(eventId: string) {
    return this.client.activityEvent(eventId);
  }
  discoverySettings() {
    return this.client.discoverySettings();
  }
  updateDiscoverySettings(body: Parameters<JobCtrlApiClient["updateDiscoverySettings"]>[0]) {
    return this.client.updateDiscoverySettings(body);
  }
  discoverySources() {
    return this.client.discoverySources();
  }
  upsertDiscoverySource(body: Parameters<JobCtrlApiClient["upsertDiscoverySource"]>[0]) {
    return this.client.upsertDiscoverySource(body);
  }
  patchDiscoverySourceState(
    sourceId: string,
    body: Parameters<JobCtrlApiClient["patchDiscoverySourceState"]>[1],
  ) {
    return this.client.patchDiscoverySourceState(sourceId, body);
  }
  discoverySourcePreview(sourceId: string) {
    return this.client.discoverySourcePreview(sourceId);
  }
  compensationSources() {
    return this.client.compensationSources();
  }
  updateCompensationSourcePolicy(
    body: Parameters<JobCtrlApiClient["updateCompensationSourcePolicy"]>[0],
  ) {
    return this.client.updateCompensationSourcePolicy(body);
  }
  discoveryLocatorCandidates() {
    return this.client.discoveryLocatorCandidates();
  }
  promoteSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobCtrlApiClient["promoteSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.promoteSourceLocatorCandidate(candidateId, body);
  }
  rejectSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobCtrlApiClient["rejectSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.rejectSourceLocatorCandidate(candidateId, body);
  }
  discoveryQuarantine() {
    return this.client.discoveryQuarantine();
  }
  decideDiscoveryQuarantine(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["decideDiscoveryQuarantine"]>[1],
  ) {
    return this.client.decideDiscoveryQuarantine(jobKey, body);
  }
  manualCaptureQueue() {
    return this.client.manualCaptureQueue();
  }
  importManualCapture(itemId: string, body: Parameters<JobCtrlApiClient["importManualCapture"]>[1]) {
    return this.client.importManualCapture(itemId, body);
  }
  dismissManualCapture(
    itemId: string,
    body: Parameters<JobCtrlApiClient["dismissManualCapture"]>[1] = {},
  ) {
    return this.client.dismissManualCapture(itemId, body);
  }
  recordDiscoveryFeedback(body: Parameters<JobCtrlApiClient["recordDiscoveryFeedback"]>[0]) {
    return this.client.recordDiscoveryFeedback(body);
  }
  roleMatchFeedbackSuggestions() {
    return this.client.roleMatchFeedbackSuggestions();
  }
  decideRoleMatchFeedbackSuggestion(
    suggestionId: string,
    body: Parameters<JobCtrlApiClient["decideRoleMatchFeedbackSuggestion"]>[1],
  ) {
    return this.client.decideRoleMatchFeedbackSuggestion(suggestionId, body);
  }
  applyReviewQueue() {
    return this.client.applyReviewQueue();
  }
  decideApplyReview(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["decideApplyReview"]>[1],
  ) {
    return this.client.decideApplyReview(jobKey, body);
  }
  confirmRepeatApplication(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["confirmRepeatApplication"]>[1],
  ) {
    return this.client.confirmRepeatApplication(jobKey, body);
  }
  resumeReviewDraft(jobKey: string) {
    return this.client.resumeReviewDraft(jobKey);
  }
  createResumeReviewDraft(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["createResumeReviewDraft"]>[1] = {},
  ) {
    return this.client.createResumeReviewDraft(jobKey, body);
  }
  saveResumeReviewDraftRevision(
    draftId: string,
    body: Parameters<JobCtrlApiClient["saveResumeReviewDraftRevision"]>[1],
  ) {
    return this.client.saveResumeReviewDraftRevision(draftId, body);
  }
  seedResumeReviewCommentThreads(
    draftId: string,
    body: Parameters<JobCtrlApiClient["seedResumeReviewCommentThreads"]>[1],
  ) {
    return this.client.seedResumeReviewCommentThreads(draftId, body);
  }
  renderResumeReviewDraft(
    draftId: string,
    body: Parameters<JobCtrlApiClient["renderResumeReviewDraft"]>[1] = {},
  ) {
    return this.client.renderResumeReviewDraft(draftId, body);
  }
  replyToResumeReviewComment(
    threadId: string,
    body: Parameters<JobCtrlApiClient["replyToResumeReviewComment"]>[1],
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
  saveResumeTemplate(body: Parameters<JobCtrlApiClient["saveResumeTemplate"]>[0]) {
    return this.client.saveResumeTemplate(body);
  }
  setDefaultResumeTemplate(body: Parameters<JobCtrlApiClient["setDefaultResumeTemplate"]>[0]) {
    return this.client.setDefaultResumeTemplate(body);
  }
  setJobResumeTemplate(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["setJobResumeTemplate"]>[1],
  ) {
    return this.client.setJobResumeTemplate(jobKey, body);
  }
  ensureCurrentResumeMaterials(
    jobKey: string,
    body: Parameters<JobCtrlApiClient["ensureCurrentResumeMaterials"]>[1] = {},
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
    body: Parameters<JobCtrlApiClient["recordManualApplicationOutcome"]>[1],
  ) {
    return this.client.recordManualApplicationOutcome(jobKey, body);
  }
  decideOutcomeSuggestion(
    suggestionId: string,
    body: Parameters<JobCtrlApiClient["decideOutcomeSuggestion"]>[1],
  ) {
    return this.client.decideOutcomeSuggestion(suggestionId, body);
  }
  jobs(query: Parameters<JobCtrlApiClient["jobs"]>[0] = {}) {
    return this.client.jobs(query);
  }
  job(jobKey: string) {
    return this.client.job(jobKey);
  }
  evidenceMap() {
    return this.client.evidenceMap();
  }
  deleteJob(jobKey: string, body: Parameters<JobCtrlApiClient["deleteJob"]>[1] = {}) {
    return this.client.deleteJob(jobKey, body);
  }
  deleteJobs(body: Parameters<JobCtrlApiClient["deleteJobs"]>[0]) {
    return this.client.deleteJobs(body);
  }
  permanentlyDeleteJob(jobKey: string) {
    return this.client.permanentlyDeleteJob(jobKey);
  }
  permanentlyDeleteJobs(body: Parameters<JobCtrlApiClient["permanentlyDeleteJobs"]>[0]) {
    return this.client.permanentlyDeleteJobs(body);
  }
  restoreJob(jobKey: string) {
    return this.client.restoreJob(jobKey);
  }
  restoreJobs(body: Parameters<JobCtrlApiClient["restoreJobs"]>[0]) {
    return this.client.restoreJobs(body);
  }
  hideJob(jobKey: string, body: Parameters<JobCtrlApiClient["hideJob"]>[1] = {}) {
    return this.client.hideJob(jobKey, body);
  }
  hideJobs(body: Parameters<JobCtrlApiClient["hideJobs"]>[0]) {
    return this.client.hideJobs(body);
  }
  unhideJob(jobKey: string) {
    return this.client.unhideJob(jobKey);
  }
  unhideJobs(body: Parameters<JobCtrlApiClient["unhideJobs"]>[0]) {
    return this.client.unhideJobs(body);
  }
  retryFailedJobs(body: Parameters<JobCtrlApiClient["retryFailedJobs"]>[0]) {
    return this.client.retryFailedJobs(body);
  }
  correctScore(jobKey: string, body: Parameters<JobCtrlApiClient["correctScore"]>[1]) {
    return this.client.correctScore(jobKey, body);
  }
  resetStaleScoresForRescore(body: Parameters<JobCtrlApiClient["resetStaleScoresForRescore"]>[0]) {
    return this.client.resetStaleScoresForRescore(body);
  }
  rescoreJob(jobKey: string, body: Parameters<JobCtrlApiClient["rescoreJob"]>[1] = {}) {
    return this.client.rescoreJob(jobKey, body);
  }
  refreshCompensation(jobKey: string, body: Parameters<JobCtrlApiClient["refreshCompensation"]>[1] = {}) {
    return this.client.refreshCompensation(jobKey, body);
  }
  refreshAllCompensation(body: Parameters<JobCtrlApiClient["refreshAllCompensation"]>[0] = {}) {
    return this.client.refreshAllCompensation(body);
  }
  rescoreJobsNotOnCurrentScoringPolicy(
    body: Parameters<JobCtrlApiClient["rescoreJobsNotOnCurrentScoringPolicy"]>[0],
  ) {
    return this.client.rescoreJobsNotOnCurrentScoringPolicy(body);
  }
  retailorJob(jobKey: string, body: Parameters<JobCtrlApiClient["retailorJob"]>[1] = {}) {
    return this.client.retailorJob(jobKey, body);
  }
  tailorJob(jobKey: string, body: Parameters<JobCtrlApiClient["tailorJob"]>[1] = {}) {
    return this.client.tailorJob(jobKey, body);
  }
  retailorCurrentPolicy(body: Parameters<JobCtrlApiClient["retailorCurrentPolicy"]>[0]) {
    return this.client.retailorCurrentPolicy(body);
  }
  workflowRuns(query: Parameters<JobCtrlApiClient["workflowRuns"]>[0] = {}) {
    return this.client.workflowRuns(query);
  }
  workflowRun(runId: string) {
    return this.client.workflowRun(runId);
  }
  cancelWorkflowRun(runId: string) {
    return this.client.cancelWorkflowRun(runId);
  }
  artifacts(query: Parameters<JobCtrlApiClient["artifacts"]>[0] = {}) {
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
  updateProfile(body: Parameters<JobCtrlApiClient["updateProfile"]>[0]) {
    return this.client.updateProfile(body);
  }
  importResume(body: Parameters<JobCtrlApiClient["importResume"]>[0]) {
    return this.client.importResume(body);
  }
  settings() {
    return this.client.settings();
  }
  updateSettings(body: Parameters<JobCtrlApiClient["updateSettings"]>[0]) {
    return this.client.updateSettings(body);
  }
  extensionCapabilityToken() {
    return this.client.extensionCapabilityToken();
  }
  rotateExtensionCapabilityToken() {
    return this.client.rotateExtensionCapabilityToken();
  }
  runPipelineStages(body: Parameters<JobCtrlApiClient["runPipelineStages"]>[0]) {
    return this.client.runPipelineStages(body);
  }
  runPendingPreparation(body: Parameters<JobCtrlApiClient["runPendingPreparation"]>[0]) {
    return this.client.runPendingPreparation(body);
  }
  credentials() {
    return this.client.credentials();
  }
  updateCredential(body: Parameters<JobCtrlApiClient["updateCredential"]>[0]) {
    return this.client.updateCredential(body);
  }
  deleteCredential(key: Parameters<JobCtrlApiClient["deleteCredential"]>[0]) {
    return this.client.deleteCredential(key);
  }
  updateCredentialsBatch(
    body: Parameters<JobCtrlApiClient["updateCredentialsBatch"]>[0],
  ) {
    return this.client.updateCredentialsBatch(body);
  }
  browserCapabilities() {
    return this.client.browserCapabilities();
  }
  enableBrowserCapability(
    capabilityId: Parameters<JobCtrlApiClient["enableBrowserCapability"]>[0],
    body: Parameters<JobCtrlApiClient["enableBrowserCapability"]>[1],
  ) {
    return this.client.enableBrowserCapability(capabilityId, body);
  }
  disableBrowserCapability(
    capabilityId: Parameters<JobCtrlApiClient["disableBrowserCapability"]>[0],
  ) {
    return this.client.disableBrowserCapability(capabilityId);
  }
  copyLinkedInBrowserProfile(
    body: Parameters<JobCtrlApiClient["copyLinkedInBrowserProfile"]>[0],
  ) {
    return this.client.copyLinkedInBrowserProfile(body);
  }
  providerModels() {
    return this.client.providerModels();
  }
  providerStatus() {
    return this.client.providerStatus();
  }
  verifyCodexProvider() {
    return this.client.verifyCodexProvider();
  }
  retryStage(jobKey: string, body: Parameters<JobCtrlApiClient["retryStage"]>[1]) {
    return this.client.retryStage(jobKey, body);
  }
  runJobStage(jobKey: string, body: Parameters<JobCtrlApiClient["runJobStage"]>[1]) {
    return this.client.runJobStage(jobKey, body);
  }
  generateMaterials(jobKey: string, body: Parameters<JobCtrlApiClient["generateMaterials"]>[1] = {}) {
    return this.client.generateMaterials(jobKey, body);
  }
  generateInterviewPrep(jobKey: string, body: Parameters<JobCtrlApiClient["generateInterviewPrep"]>[1] = {}) {
    return this.client.generateInterviewPrep(jobKey, body);
  }
  applyJob(jobKey: string, body: Parameters<JobCtrlApiClient["applyJob"]>[1] = {}) {
    return this.client.applyJob(jobKey, body);
  }
  cancelJobAction(jobKey: string, body: Parameters<JobCtrlApiClient["cancelJobAction"]>[1] = {}) {
    return this.client.cancelJobAction(jobKey, body);
  }
  markApplied(jobKey: string, body: Parameters<JobCtrlApiClient["markApplied"]>[1] = {}) {
    return this.client.markApplied(jobKey, body);
  }
  markSkipped(jobKey: string, body: Parameters<JobCtrlApiClient["markSkipped"]>[1] = {}) {
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
  outreachThread(contactId: string, query: Parameters<JobCtrlApiClient["outreachThread"]>[1] = {}) {
    return this.client.outreachThread(contactId, query);
  }
  generateOutreachDraft(
    contactId: string,
    body: Parameters<JobCtrlApiClient["generateOutreachDraft"]>[1] = {},
  ) {
    return this.client.generateOutreachDraft(contactId, body);
  }
  reviseOutreachDraft(
    threadId: string,
    body: Parameters<JobCtrlApiClient["reviseOutreachDraft"]>[1],
  ) {
    return this.client.reviseOutreachDraft(threadId, body);
  }
  approveOutreachDraft(threadId: string, draftId: string) {
    return this.client.approveOutreachDraft(threadId, draftId);
  }
  rejectOutreachDraft(
    threadId: string,
    draftId: string,
    body: Parameters<JobCtrlApiClient["rejectOutreachDraft"]>[2] = {},
  ) {
    return this.client.rejectOutreachDraft(threadId, draftId, body);
  }
  logOutreachSend(
    threadId: string,
    body: Parameters<JobCtrlApiClient["logOutreachSend"]>[1],
  ) {
    return this.client.logOutreachSend(threadId, body);
  }
  scheduleOutreachFollowUp(
    threadId: string,
    body: Parameters<JobCtrlApiClient["scheduleOutreachFollowUp"]>[1] = {},
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

export interface FetchApiClientAdapter extends EndpointClientMethods {}
