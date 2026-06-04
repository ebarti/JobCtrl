import { JobHunterApiClient } from "@jobhunter/api-client";
import type { ApiClientPort } from "../../ports/ApiClientPort.js";

export class FetchApiClientAdapter implements ApiClientPort {
  private readonly client: JobHunterApiClient;

  constructor(baseUrl?: string) {
    this.client = new JobHunterApiClient(baseUrl);
  }

  health(): ReturnType<JobHunterApiClient["health"]> {
    return this.client.health();
  }
  dashboardSummary() {
    return this.client.dashboardSummary();
  }
  activity(query: Parameters<JobHunterApiClient["activity"]>[0] = {}) {
    return this.client.activity(query);
  }
  activityEvent(eventId: string) {
    return this.client.activityEvent(eventId);
  }
  discoverySettings() {
    return this.client.discoverySettings();
  }
  updateDiscoverySettings(body: Parameters<JobHunterApiClient["updateDiscoverySettings"]>[0]) {
    return this.client.updateDiscoverySettings(body);
  }
  discoverySources() {
    return this.client.discoverySources();
  }
  upsertDiscoverySource(body: Parameters<JobHunterApiClient["upsertDiscoverySource"]>[0]) {
    return this.client.upsertDiscoverySource(body);
  }
  patchDiscoverySourceState(
    sourceId: string,
    body: Parameters<JobHunterApiClient["patchDiscoverySourceState"]>[1],
  ) {
    return this.client.patchDiscoverySourceState(sourceId, body);
  }
  discoverySourcePreview(sourceId: string) {
    return this.client.discoverySourcePreview(sourceId);
  }
  discoveryLocatorCandidates() {
    return this.client.discoveryLocatorCandidates();
  }
  promoteSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobHunterApiClient["promoteSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.promoteSourceLocatorCandidate(candidateId, body);
  }
  rejectSourceLocatorCandidate(
    candidateId: string,
    body: Parameters<JobHunterApiClient["rejectSourceLocatorCandidate"]>[1] = {},
  ) {
    return this.client.rejectSourceLocatorCandidate(candidateId, body);
  }
  discoveryQuarantine() {
    return this.client.discoveryQuarantine();
  }
  decideDiscoveryQuarantine(
    jobKey: string,
    body: Parameters<JobHunterApiClient["decideDiscoveryQuarantine"]>[1],
  ) {
    return this.client.decideDiscoveryQuarantine(jobKey, body);
  }
  manualCaptureQueue() {
    return this.client.manualCaptureQueue();
  }
  importManualCapture(itemId: string, body: Parameters<JobHunterApiClient["importManualCapture"]>[1]) {
    return this.client.importManualCapture(itemId, body);
  }
  dismissManualCapture(
    itemId: string,
    body: Parameters<JobHunterApiClient["dismissManualCapture"]>[1] = {},
  ) {
    return this.client.dismissManualCapture(itemId, body);
  }
  recordDiscoveryFeedback(body: Parameters<JobHunterApiClient["recordDiscoveryFeedback"]>[0]) {
    return this.client.recordDiscoveryFeedback(body);
  }
  roleMatchFeedbackSuggestions() {
    return this.client.roleMatchFeedbackSuggestions();
  }
  decideRoleMatchFeedbackSuggestion(
    suggestionId: string,
    body: Parameters<JobHunterApiClient["decideRoleMatchFeedbackSuggestion"]>[1],
  ) {
    return this.client.decideRoleMatchFeedbackSuggestion(suggestionId, body);
  }
  applyReviewQueue() {
    return this.client.applyReviewQueue();
  }
  decideApplyReview(
    jobKey: string,
    body: Parameters<JobHunterApiClient["decideApplyReview"]>[1],
  ) {
    return this.client.decideApplyReview(jobKey, body);
  }
  applicationOutcomes() {
    return this.client.applicationOutcomes();
  }
  jobApplicationOutcomes(jobKey: string) {
    return this.client.jobApplicationOutcomes(jobKey);
  }
  recordManualApplicationOutcome(
    jobKey: string,
    body: Parameters<JobHunterApiClient["recordManualApplicationOutcome"]>[1],
  ) {
    return this.client.recordManualApplicationOutcome(jobKey, body);
  }
  decideOutcomeSuggestion(
    suggestionId: string,
    body: Parameters<JobHunterApiClient["decideOutcomeSuggestion"]>[1],
  ) {
    return this.client.decideOutcomeSuggestion(suggestionId, body);
  }
  jobs(query: Parameters<JobHunterApiClient["jobs"]>[0] = {}) {
    return this.client.jobs(query);
  }
  job(jobKey: string) {
    return this.client.job(jobKey);
  }
  deleteJob(jobKey: string, body: Parameters<JobHunterApiClient["deleteJob"]>[1] = {}) {
    return this.client.deleteJob(jobKey, body);
  }
  deleteJobs(body: Parameters<JobHunterApiClient["deleteJobs"]>[0]) {
    return this.client.deleteJobs(body);
  }
  permanentlyDeleteJob(jobKey: string) {
    return this.client.permanentlyDeleteJob(jobKey);
  }
  permanentlyDeleteJobs(body: Parameters<JobHunterApiClient["permanentlyDeleteJobs"]>[0]) {
    return this.client.permanentlyDeleteJobs(body);
  }
  restoreJob(jobKey: string) {
    return this.client.restoreJob(jobKey);
  }
  restoreJobs(body: Parameters<JobHunterApiClient["restoreJobs"]>[0]) {
    return this.client.restoreJobs(body);
  }
  hideJob(jobKey: string, body: Parameters<JobHunterApiClient["hideJob"]>[1] = {}) {
    return this.client.hideJob(jobKey, body);
  }
  hideJobs(body: Parameters<JobHunterApiClient["hideJobs"]>[0]) {
    return this.client.hideJobs(body);
  }
  unhideJob(jobKey: string) {
    return this.client.unhideJob(jobKey);
  }
  unhideJobs(body: Parameters<JobHunterApiClient["unhideJobs"]>[0]) {
    return this.client.unhideJobs(body);
  }
  retryFailedJobs(body: Parameters<JobHunterApiClient["retryFailedJobs"]>[0]) {
    return this.client.retryFailedJobs(body);
  }
  correctScore(jobKey: string, body: Parameters<JobHunterApiClient["correctScore"]>[1]) {
    return this.client.correctScore(jobKey, body);
  }
  resetStaleScoresForRescore(body: Parameters<JobHunterApiClient["resetStaleScoresForRescore"]>[0]) {
    return this.client.resetStaleScoresForRescore(body);
  }
  rescoreJob(jobKey: string, body: Parameters<JobHunterApiClient["rescoreJob"]>[1] = {}) {
    return this.client.rescoreJob(jobKey, body);
  }
  rescoreJobsNotOnCurrentScoringPolicy(
    body: Parameters<JobHunterApiClient["rescoreJobsNotOnCurrentScoringPolicy"]>[0],
  ) {
    return this.client.rescoreJobsNotOnCurrentScoringPolicy(body);
  }
  retailorJob(jobKey: string, body: Parameters<JobHunterApiClient["retailorJob"]>[1] = {}) {
    return this.client.retailorJob(jobKey, body);
  }
  retailorCurrentPolicy(body: Parameters<JobHunterApiClient["retailorCurrentPolicy"]>[0]) {
    return this.client.retailorCurrentPolicy(body);
  }
  workflowRuns(query: Parameters<JobHunterApiClient["workflowRuns"]>[0] = {}) {
    return this.client.workflowRuns(query);
  }
  cancelWorkflowRun(runId: string) {
    return this.client.cancelWorkflowRun(runId);
  }
  artifacts(query: Parameters<JobHunterApiClient["artifacts"]>[0] = {}) {
    return this.client.artifacts(query);
  }
  artifact(artifactId: string) {
    return this.client.artifact(artifactId);
  }
  artifactPreviewPdfUrl(artifactId: string, cacheKey?: number | string): string {
    return this.client.artifactPreviewPdfUrl(artifactId, cacheKey);
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
  updateProfile(body: Parameters<JobHunterApiClient["updateProfile"]>[0]) {
    return this.client.updateProfile(body);
  }
  importResume(body: Parameters<JobHunterApiClient["importResume"]>[0]) {
    return this.client.importResume(body);
  }
  settings() {
    return this.client.settings();
  }
  updateSettings(body: Parameters<JobHunterApiClient["updateSettings"]>[0]) {
    return this.client.updateSettings(body);
  }
  runPipelineStages(body: Parameters<JobHunterApiClient["runPipelineStages"]>[0]) {
    return this.client.runPipelineStages(body);
  }
  credentials() {
    return this.client.credentials();
  }
  updateCredential(body: Parameters<JobHunterApiClient["updateCredential"]>[0]) {
    return this.client.updateCredential(body);
  }
  deleteCredential(key: Parameters<JobHunterApiClient["deleteCredential"]>[0]) {
    return this.client.deleteCredential(key);
  }
  retryStage(jobKey: string, body: Parameters<JobHunterApiClient["retryStage"]>[1]) {
    return this.client.retryStage(jobKey, body);
  }
  generateMaterials(jobKey: string, body: Parameters<JobHunterApiClient["generateMaterials"]>[1] = {}) {
    return this.client.generateMaterials(jobKey, body);
  }
  applyJob(jobKey: string, body: Parameters<JobHunterApiClient["applyJob"]>[1] = {}) {
    return this.client.applyJob(jobKey, body);
  }
  cancelJobAction(jobKey: string, body: Parameters<JobHunterApiClient["cancelJobAction"]>[1] = {}) {
    return this.client.cancelJobAction(jobKey, body);
  }
  markApplied(jobKey: string, body: Parameters<JobHunterApiClient["markApplied"]>[1] = {}) {
    return this.client.markApplied(jobKey, body);
  }
  markSkipped(jobKey: string, body: Parameters<JobHunterApiClient["markSkipped"]>[1] = {}) {
    return this.client.markSkipped(jobKey, body);
  }
}
