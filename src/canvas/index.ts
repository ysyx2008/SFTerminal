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

export {
  DISK_SYNC_AFTER_TOOLS,
  shouldSyncArtifactsAfterStep
} from './artifact-disk-sync'

export {
  getArtifactContextMenuFlags,
  artifactHasFileActions,
  type ArtifactContextMenuFlags
} from './artifact-context-menu'

export {
  artifactFilePresence,
  checkFilePathExists,
  findArtifactIdsWithMissingFiles,
  refreshFilePathExistsMap,
  type ArtifactFilePresence
} from './artifact-file-status'

export {
  artifactBasename,
  canSaveArtifact,
  canSaveAsArtifact,
  defaultSaveFileName,
  listSaveableArtifacts,
  saveAllArtifacts,
  saveArtifact,
  saveArtifactAs,
  saveArtifactToPath,
  saveExtensionForRenderer,
  type ArtifactSaveDeps,
  type SaveAllResult
} from './artifact-actions'

export {
  createArtifactSaveBridge,
  provideArtifactSaveBridge,
  useArtifactSaveBridge,
  type ArtifactSaveBridge,
  type ArtifactSaveHandler
} from './artifact-save-bridge'
