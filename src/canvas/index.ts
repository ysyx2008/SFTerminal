export {
  applyCanvasData,
  clearTabArtifacts,
  createTabArtifactState,
  findArtifactForData,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  hydrateArtifactsFromSteps,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
  updateArtifactContentById,
  type TabArtifactState
} from './artifact-registry'

export {
  ARTIFACT_VISIBLE_TAB_MAX,
  filterArtifactsByQuery,
  pickVisibleArtifactTabs,
  sortArtifactsByRecent
} from './artifact-tab-layout'
