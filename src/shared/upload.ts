// Files into a page's file input over the DevTools protocol, with no native dialog (navegador_enviar_arquivo).
// One sequence for both hosts (Chrome over its pipe, src/core/chrome.ts, and Electron's debugger,
// src/main/browser.ts): the page script marks the input (shared/page.ts), DOM.querySelector finds it by
// that mark, DOM.setFileInputFiles sets the files (Chrome fires input and change itself), and the mark
// goes away. Limits: an input inside a shadow root or an iframe isn't reached.
import { L } from './lang'
import { FILE_INPUT, FILE_INPUT_DONE } from './page'

// Errors that are the agent's to read as they are (the core strips this tag, even across a process boundary).
export const UPLOAD_ERROR = 'enviar-arquivo: '
const fail = (msg: string): Error => new Error(UPLOAD_ERROR + msg)

export interface PageIo {
  run<T>(code: string): Promise<T>
  cmd(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

// A file chooser the page tried to open (Page.fileChooserOpened, intercepted so no dialog shows): sites that
// build the input when "Upload" is clicked (Google Drive) leave no input to find, only this.
export interface PendingChooser {
  backendNodeId: number
  mode: string // 'selectSingle' | 'selectMultiple'
}

const notFound = (): Error => fail(L('Não achei um campo de envio de arquivo nesse ponto da página.', "I couldn't find a file upload field at that spot on the page."))

// Sets the files; says which way they went, so the caller can drop a chooser that was used.
export async function setFileInput(io: PageIo, ref: number | undefined, paths: string[], chooser?: PendingChooser): Promise<'input' | 'chooser'> {
  const token = `t${Math.random().toString(36).slice(2, 10)}`
  const found = ref === undefined ? 'none' : await io.run<string>(FILE_INPUT(ref, token, paths.length))
  if (found === 'gone') throw fail(L('Esse elemento não está mais na página. Leia a página de novo.', 'That element is no longer on the page. Read the page again.'))
  if (found === 'single') throw fail(L('Esse campo aceita só um arquivo.', 'That field takes only one file.'))
  if (found === 'disabled') throw fail(L('Esse campo de envio está desativado na página.', 'That upload field is disabled on the page.'))
  if (found !== token) {
    // The pending chooser stands in only when no field was named; with a field, not finding its input is the error.
    if (ref !== undefined || !chooser) throw notFound()
    if (chooser.mode === 'selectSingle' && paths.length > 1) throw fail(L('Esse campo aceita só um arquivo.', 'That field takes only one file.'))
    await io.cmd('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId })
    return 'chooser'
  }
  try {
    const { root } = (await io.cmd('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } }
    const { nodeId } = (await io.cmd('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-ad-file="${token}"]` })) as { nodeId: number }
    if (!nodeId) throw notFound()
    await io.cmd('DOM.setFileInputFiles', { files: paths, nodeId })
    return 'input'
  } finally {
    await io.run(FILE_INPUT_DONE(token)).catch(() => {})
  }
}
