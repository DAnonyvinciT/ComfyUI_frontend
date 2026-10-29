import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import { useI18n } from 'vue-i18n'

import { useFeatureFlags } from '@/composables/useFeatureFlags'
import type { UploadModelSuccess } from '@/platform/assets/composables/useUploadModelWizard'
import { modelFileUploadApi } from '@/platform/workspace/api/modelFileUploadApi'
import type { ModelFileUploadResult } from '@/platform/workspace/api/modelFileUploadApi'
import { reportError } from '@comfyorg/telemetry/reportError'
import {
  isDownloadCancelled,
  useAssetDownloadStore
} from '@/stores/assetDownloadStore'

const MODEL_FILE_EXTENSION = '.safetensors'
const DEFAULT_MODEL_TYPE = 'loras'

type UploadStopped = Extract<ModelFileUploadResult, { ok: false }>

/** The words for each way an upload stops; any other failure shows the server's message or the generic one. */
const FAILURE_COPY: Partial<Record<UploadStopped['reason'], string>> = {
  cancelled: 'assetBrowser.fileUpload.cancelled',
  unsupportedFile: 'assetBrowser.fileUpload.notSafetensors',
  unsupportedType: 'assetBrowser.fileUpload.unsupportedType',
  privateModelsDisabled: 'assetBrowser.fileUpload.privateModelsDisabled',
  planUnavailable: 'assetBrowser.fileUpload.planUnavailable'
}

/** Where one model file upload stands. */
export type ModelFileUpload =
  | { status: 'idle'; error?: string }
  | { status: 'chosen'; file: File }
  | { status: 'uploading'; file: File; sent: number }
  | { status: 'saving'; file: File }
  | { status: 'done'; file: File; modelType: string }
  | { status: 'failed'; file: File; error: string; taskId?: string }

type ReadyToSend = Extract<ModelFileUpload, { status: 'chosen' | 'failed' }>

interface FollowedTask {
  id: string
  outcome: () => ModelFileUpload | undefined
  settling: boolean
}

/**
 * One model file chosen from the computer and uploaded into the workspace
 * library: choose it, pick its type, upload with progress or cancel.
 */
export function useUploadModelFile() {
  const { t } = useI18n()
  const { flags } = useFeatureFlags()
  const downloads = useAssetDownloadStore()
  const uploadFolders = computed(() => flags.modelUploadFolders)
  const isAvailable = computed(
    () => flags.runtimeLibraryModelsEnabled && uploadFolders.value.length > 0
  )

  function defaultModelType() {
    return uploadFolders.value.includes(DEFAULT_MODEL_TYPE)
      ? DEFAULT_MODEL_TYPE
      : (uploadFolders.value[0] ?? '')
  }

  const state = shallowRef<ModelFileUpload>({ status: 'idle' })
  const modelType = ref(defaultModelType())
  let controller: AbortController | undefined
  let task: FollowedTask | undefined
  let stopTaskWatch: WatchStopHandle | undefined
  let endCancellationWait: (() => void) | undefined
  let generation = 0

  function stopFollowing() {
    stopTaskWatch?.()
    stopTaskWatch = undefined
    task = undefined
  }

  function stop() {
    generation++
    controller?.abort()
    stopFollowing()
    endCancellationWait?.()
  }

  onScopeDispose(stop)

  function choose(file: File) {
    if (!file.name.toLowerCase().endsWith(MODEL_FILE_EXTENSION)) {
      state.value = {
        status: 'idle',
        error: t('assetBrowser.fileUpload.notSafetensors')
      }
      return
    }
    modelType.value = defaultModelType()
    state.value = { status: 'chosen', file }
  }

  function failureText(failure: UploadStopped) {
    const copy = FAILURE_COPY[failure.reason]
    if (copy) return t(copy)
    return failure.message ?? t('assetBrowser.fileUpload.failed')
  }

  function taskOutcome(
    taskId: string,
    file: File,
    type: string
  ): ModelFileUpload | undefined {
    if (downloads.lastCompletedDownload?.taskId === taskId) {
      return { status: 'done', file, modelType: type }
    }
    const download = downloads.downloadList.find((d) => d.taskId === taskId)
    if (!download) return undefined
    if (download.status === 'completed') {
      return { status: 'done', file, modelType: type }
    }
    if (download.status === 'failed') {
      return {
        status: 'failed',
        file,
        taskId,
        error: download.error || t('assetBrowser.fileUpload.failed')
      }
    }
    if (isDownloadCancelled(download.status)) {
      return {
        status: 'failed',
        file,
        taskId,
        error: t('assetBrowser.fileUpload.cancelled')
      }
    }
    return undefined
  }

  function followTask(taskId: string, file: File, type: string) {
    downloads.trackDownload(taskId, type, file.name, { source: 'upload' })
    state.value = { status: 'saving', file }
    const followed: FollowedTask = {
      id: taskId,
      outcome: () => taskOutcome(taskId, file, type),
      settling: false
    }
    task = followed
    stopTaskWatch = watch(
      followed.outcome,
      (outcome) => {
        if (task === followed && !followed.settling && outcome) {
          state.value = outcome
        }
      },
      { immediate: true }
    )
  }

  function taskStatus(taskId: string) {
    return downloads.downloadList.find((d) => d.taskId === taskId)?.status
  }

  function cancellationSettled(taskId: string): Promise<void> {
    const pending = () => taskStatus(taskId) === 'cancellation_pending'
    if (!pending()) return Promise.resolve()
    return new Promise((resolve) => {
      const unwatch = watch(pending, (stillPending) => {
        if (!stillPending) endCancellationWait?.()
      })
      endCancellationWait = () => {
        unwatch()
        endCancellationWait = undefined
        resolve()
      }
    })
  }

  async function cancelTask(taskId: string, run: number): Promise<boolean> {
    const cancelled = await downloads.cancelDownload(taskId)
    if (!cancelled.ok) {
      reportError(cancelled.error, {
        surface: 'assets',
        errorType: 'asset_download_cancellation_failure',
        level: 'warning'
      })
      return false
    }
    if (run === generation) await cancellationSettled(taskId)
    return true
  }

  function hasStopped(taskId: string) {
    const status = taskStatus(taskId)
    return status === 'cancelled' || status === 'failed'
  }

  function notSentAgain(followed: FollowedTask, file: File): ModelFileUpload {
    const outcome = followed.outcome()
    if (outcome?.status === 'done') return outcome
    return {
      status: 'failed',
      file,
      taskId: followed.id,
      error: t('assetBrowser.fileUpload.notStopped')
    }
  }

  function followedTaskOf(previous: ReadyToSend) {
    return previous.status === 'failed' && previous.taskId === task?.id
      ? task
      : undefined
  }

  async function settleFollowedTask(
    followed: FollowedTask,
    previous: ReadyToSend,
    run: number
  ): Promise<boolean> {
    followed.settling = true
    const cancelled = await cancelTask(followed.id, run)
    followed.settling = false
    if (run !== generation) return false
    if (!cancelled) {
      state.value = followed.outcome() ?? previous
      return false
    }
    if (hasStopped(followed.id)) return true
    state.value = notSentAgain(followed, previous.file)
    return false
  }

  function beginAttempt() {
    generation++
    controller?.abort()
    controller = new AbortController()
    return { run: generation, signal: controller.signal }
  }

  async function upload(): Promise<UploadModelSuccess | null> {
    const current = state.value
    if (current.status !== 'chosen' && current.status !== 'failed') return null

    const { run, signal } = beginAttempt()
    const { file } = current
    const type = modelType.value
    state.value = { status: 'uploading', file, sent: 0 }

    const followed = followedTaskOf(current)
    if (followed && !(await settleFollowedTask(followed, current, run))) {
      return null
    }
    stopFollowing()

    const result = await modelFileUploadApi.uploadModelFile(file, {
      tags: ['models', type],
      signal,
      onProgress: (sent) => {
        if (run === generation)
          state.value = { status: 'uploading', file, sent }
      }
    })
    if (run !== generation) return null

    if (!result.ok) {
      if (result.reason === 'failed') {
        reportError(result.cause, {
          surface: 'assets',
          errorType: 'error_uploading_model_file',
          level: 'warning'
        })
      }
      state.value = { status: 'failed', file, error: failureText(result) }
      return null
    }

    followTask(result.taskId, file, type)
    return {
      filename: file.name,
      modelType: type,
      taskId: result.taskId,
      status: 'processing'
    }
  }

  function cancel() {
    controller?.abort()
    endCancellationWait?.()
  }

  function reset() {
    stop()
    state.value = { status: 'idle' }
    modelType.value = defaultModelType()
  }

  return {
    isAvailable,
    uploadFolders,
    state,
    modelType,
    choose,
    upload,
    cancel,
    reset
  }
}
