// navegador_enviar_arquivo: files from the agent's computer (/work) into a page's file input, with no
// native dialog. The files are copied out of the container into <dataDir>/uploads/<uuid>/ and handed to
// the browser by path (DOM.setFileInputFiles, see shared/upload.ts). Chrome reads such a file lazily, when
// the page reads it or the form is sent, so the copy can't go as soon as the files are set: each folder is
// removed 2 hours later, and any older ones are swept at startup and the next time something is uploaded
// (a restart drops the timers, so the sweep is what cleans up after one).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { Agent, BrowserReply } from '../shared/types'
import type { BrowserHost } from './browser'
import type { ToolDef } from './gateway'
import { UPLOAD_ERROR } from '../shared/upload'
import { containerPath } from './computer'

export const ENVIAR = 'navegador_enviar_arquivo'
const KEEP_MS = 2 * 60 * 60_000
const MAX_FILES = 10
const WORK = '/work'

// "a.pdf, /work/b.png" → paths inside /work, or what's wrong with them.
export function uploadPaths(arg: string): { paths: string[] } | { error: string } {
  const names = arg
    .split(',')
    .map((n) => n.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
  if (!names.length) return { error: L('Faltou o arquivo: diga o caminho em /work (vários, separados por vírgula).', 'Missing the file: give its path in /work (several, separated by commas).') }
  if (names.length > MAX_FILES) return { error: L(`No máximo ${MAX_FILES} arquivos de cada vez.`, `At most ${MAX_FILES} files at a time.`) }
  const paths = names.map(containerPath)
  const out = names.find((_, i) => !paths[i]!.startsWith(`${WORK}/`))
  if (out) return { error: L(`Só dá pra enviar arquivos de dentro de ${WORK}. "${out}" está fora.`, `Only files inside ${WORK} can be uploaded. "${out}" is outside it.`) }
  return { paths }
}

// Removes the upload folders older than KEEP_MS. Called at startup and before each upload.
export function sweepUploads(dataDir: string): void {
  const root = join(dataDir, 'uploads')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const d of readdirSync(root)) {
    try {
      if (Date.now() - statSync(join(root, d)).mtimeMs > KEEP_MS) rmSync(join(root, d), { recursive: true, force: true })
    } catch {}
  }
}

// A fresh folder for one upload, after removing the old ones.
export function newUploadDir(dataDir: string): string {
  sweepUploads(dataDir)
  const dir = join(dataDir, 'uploads', randomUUID())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export const dropLater = (dir: string): void => void setTimeout(() => rmSync(dir, { recursive: true, force: true }), KEEP_MS).unref()
export const dropNow = (dir: string): void => rmSync(dir, { recursive: true, force: true })

// What the browser host said, without the tag that marks a message for the agent.
export const uploadError = (e: unknown): string | undefined => {
  const m = e instanceof Error ? e.message : String(e)
  const at = m.indexOf(UPLOAD_ERROR)
  return at >= 0 ? m.slice(at + UPLOAD_ERROR.length) : undefined
}

export const noUploadHere = (): string => L('Enviar arquivo só funciona no navegador do próprio Tucano, não no navegador do Mac conectado.', "Uploading a file only works in Tucano's own browser, not in the connected Mac's browser.")

export const enviarTool = (alvo: Record<string, unknown>): ToolDef => ({
  name: ENVIAR,
  description: L(
    'Põe arquivos do seu computador (/work) num campo de envio da página, sem abrir a janela de escolher arquivo. Aponte o campo de envio, ou o botão/área que leva a ele. Depois clique no botão de salvar/enviar da página, se houver. Se o site abre a janela de escolher arquivo ao clicar (como o Google Drive), clique antes no botão de envio com navegador_clicar e depois chame esta ferramenta sem alvo.',
    "Puts files from your computer (/work) into a page's upload field, without opening the choose-file window. Point at the upload field, or at the button/area that leads to it. Then click the page's save/send button, if any."
  ),
  inputSchema: {
    type: 'object',
    properties: {
      alvo: { ...alvo, description: `${String(alvo['description'])} ${L('Deixe vazio só no caso da janela de arquivos (veja acima).', 'Leave empty only for the file-window case (see above).')}` },
      arquivo: { type: 'string', description: L('O caminho do arquivo em /work (relativo vale). Vários: separe por vírgula.', 'The path of the file in /work (relative works). Several: separate with commas.') }
    },
    required: ['arquivo']
  }
})

// Copies the files out of the agent's computer and sets them in the field behind element `ref`.
export async function uploadFiles(
  deps: { host: BrowserHost; dataDir: string; files?: (agent: Agent, paths: string[], dir: string) => Promise<{ paths: string[] } | { error: string }> },
  agent: Agent,
  ref: number | undefined,
  paths: string[]
): Promise<{ reply: BrowserReply; names: string; said: string } | { error: string }> {
  if (!deps.files) return { error: L('Esse agente não tem um computador pra tirar o arquivo.', 'This agent has no computer to take the file from.') }
  const dir = newUploadDir(deps.dataDir)
  const copied = await deps.files(agent, paths, dir)
  if ('error' in copied) {
    dropNow(dir)
    return { error: copied.error }
  }
  try {
    const reply = await deps.host(agent.id, 'setFiles', { ref, paths: copied.paths })
    dropLater(dir)
    const names = paths.map((p) => p.split('/').pop()).join(', ')
    return { reply, names, said: L(`Arquivo(s) no campo: ${names}. Falta clicar no botão de salvar/enviar da página, se houver.`, `File(s) in the field: ${names}. Still to click the page's save/send button, if there is one.`) }
  } catch (e) {
    dropNow(dir)
    const plain = uploadError(e)
    if (plain) return { error: plain }
    throw e
  }
}
