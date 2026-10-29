import { render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'

import { useFeatureFlags } from '@/composables/useFeatureFlags'
import enMessages from '@/locales/en/main.json' with { type: 'json' }
import { modelFileUploadApi } from '@/platform/workspace/api/modelFileUploadApi'
import { api } from '@/scripts/api'

import UploadModelDialog from '@/platform/assets/components/UploadModelDialog.vue'

vi.mock(import('@/composables/useFeatureFlags'))
vi.mock(import('@/scripts/api'))

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: enMessages },
  missingWarn: false,
  fallbackWarn: false
})

function renderDialog(
  props: InstanceType<typeof UploadModelDialog>['$props'] = {}
) {
  render(UploadModelDialog, {
    props,
    global: { plugins: [i18n], stubs: { VideoHelpDialog: true } }
  })
}

const missingLora = {
  kind: 'missing-model-resolution' as const,
  missingModelName: 'my_style_v2.safetensors',
  requiredModelType: 'loras',
  replacementTargets: []
}

function uploadsOn(folders = ['checkpoints', 'loras']) {
  const flags = vi.mocked(useFeatureFlags().flags)
  flags.runtimeLibraryModelsEnabled = true
  flags.modelUploadFolders = folders
}

describe('UploadModelDialog file upload', () => {
  beforeEach(() => {
    vi.mocked(api.getModelFolders).mockResolvedValue([
      { name: 'loras', folders: [] },
      { name: 'checkpoints', folders: [] }
    ])
  })

  it('offers only the link import while the flag is off', () => {
    renderDialog()

    expect(
      screen.getByPlaceholderText(
        enMessages.assetBrowser.genericLinkPlaceholder
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Choose a file')).not.toBeInTheDocument()
  })

  it('offers a file from the computer while the flag is on', () => {
    uploadsOn()
    renderDialog()

    expect(screen.getByText('Choose a file')).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(
        enMessages.assetBrowser.genericLinkPlaceholder
      )
    ).toBeInTheDocument()
  })

  it('keeps a missing-model import to links', () => {
    uploadsOn()
    renderDialog({ uploadContext: missingLora })

    expect(screen.queryByText('Choose a file')).not.toBeInTheDocument()
  })

  it('moves to the file, its type and Upload once a file is chosen, and Back returns', async () => {
    uploadsOn()
    const user = userEvent.setup()
    renderDialog()

    await user.upload(
      screen.getByTestId('upload-model-file-input'),
      new File(['0123456789'], 'my_style_v2.safetensors')
    )

    expect(screen.getByText('my_style_v2.safetensors')).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.assetBrowser.modelTypeSelectorLabel)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Choose a file')).toBeInTheDocument()
  })

  it('says why a file that is not .safetensors was not taken', async () => {
    uploadsOn()
    const user = userEvent.setup({ applyAccept: false })
    renderDialog()

    await user.upload(
      screen.getByTestId('upload-model-file-input'),
      new File(['x'], 'notes.txt')
    )

    expect(
      screen.getByText('Only .safetensors files can be uploaded.')
    ).toBeInTheDocument()
  })

  it('offers no file option when the server lists no upload folders', () => {
    uploadsOn([])
    renderDialog()

    expect(screen.queryByText('Choose a file')).not.toBeInTheDocument()
  })

  it('offers only the types the server can store, LoRA first', async () => {
    uploadsOn(['loras', 'vae'])
    const user = userEvent.setup()
    renderDialog()

    await user.upload(
      screen.getByTestId('upload-model-file-input'),
      new File(['0123456789'], 'my_style_v2.safetensors')
    )
    const picker = screen.getByRole('combobox', {
      name: enMessages.assetBrowser.modelTypeSelectorLabel
    })
    expect(picker).toHaveTextContent('LoRA')

    await user.click(picker)
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent.trim())).toEqual([
      'LoRA',
      'vae'
    ])
  })

  it('keeps the type picker after the server refuses a type, so another can be tried', async () => {
    uploadsOn(['loras', 'vae'])
    const send = vi
      .spyOn(modelFileUploadApi, 'uploadModelFile')
      .mockResolvedValueOnce({ ok: false, reason: 'unsupportedType' })
      .mockResolvedValueOnce({ ok: false, reason: 'failed' })
    const user = userEvent.setup()
    renderDialog()

    await user.upload(
      screen.getByTestId('upload-model-file-input'),
      new File(['0123456789'], 'my_style_v2.safetensors')
    )
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(
      await screen.findByText(
        "Cloud can't store this model type yet. Choose another type."
      )
    ).toBeInTheDocument()
    const picker = screen.getByRole('combobox', {
      name: enMessages.assetBrowser.modelTypeSelectorLabel
    })
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: 'vae' }))
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(send).toHaveBeenLastCalledWith(
      expect.any(File),
      expect.objectContaining({ tags: ['models', 'vae'] })
    )
  })
})
