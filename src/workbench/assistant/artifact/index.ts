export {
  applyCanvasData,
  clearTabArtifacts,
  createTabArtifactState,
  dismissEmptyPanel,
  findArtifactForData,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  hasArtifacts,
  hidePanel,
  hydrateArtifactsFromSteps,
  isArtifactEmptyState,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
  showPanel,
  updateArtifactContentById,
  type TabArtifactState
} from './domain/artifact-registry'

export {
  ARTIFACT_VISIBLE_TAB_MAX,
  filterArtifactsByQuery,
  pickVisibleArtifactTabs,
  sortArtifactsByRecent
} from './domain/artifact-tab-layout'

export {
  DISK_SYNC_AFTER_TOOLS,
  shouldSyncArtifactsAfterStep
} from './domain/artifact-disk-sync'

export {
  getArtifactContextMenuFlags,
  artifactHasFileActions,
  type ArtifactContextMenuFlags
} from './domain/artifact-context-menu'

export {
  artifactFilePresence,
  checkFilePathExists,
  findArtifactIdsWithMissingFiles,
  refreshFilePathExistsMap,
  type ArtifactFilePresence
} from './domain/artifact-file-status'

export {
  artifactBasename,
  artifactDisplayLabel,
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
} from './domain/artifact-actions'

export {
  createArtifactSaveBridge,
  provideArtifactSaveBridge,
  useArtifactSaveBridge,
  type ArtifactSaveBridge,
  type ArtifactSaveHandler
} from './domain/artifact-save-bridge'

export {
  enrichCanvasDataFromStep,
  resolveSourceStepIdById,
  resolveVisibleSourceStepId,
  type SourceStepLike
} from './domain/artifact-source'

export {
  getRendererCapabilities,
  getArtifactSaveStrategy,
  isArtifactEditable,
  isRendererEditable,
  type RendererCapabilities,
  type RendererSaveStrategy
} from './renderers/registry'

export {
  getRendererUi,
  getRendererComponent,
  getRendererIcon,
  type RendererUiDescriptor
} from './renderers/ui-registry'

export {
  useAssistantArtifactStore,
  useCanvasStore,
  type ArtifactDiskSyncEvent,
  type ArtifactSourceJumpRequest
} from './store'
