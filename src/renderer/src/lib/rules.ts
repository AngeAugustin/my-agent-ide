import { parseRule, ROOT_RULE_FILES, RULE_DIRS, rulesPrompt, selectRules, type ProjectRule } from '@shared/rules'
import { isInside, join, relative } from './paths'
import { useIde } from '../store/ide'

/** Charge les règles du projet ouvert (fichiers racine et dossiers de règles). */
export async function loadProjectRules(root: string): Promise<ProjectRule[]> {
  const rules: ProjectRule[] = []
  for (const name of ROOT_RULE_FILES) {
    const path = join(root, name)
    try {
      if (await window.api.fs.exists(path)) rules.push(parseRule(name, await window.api.fs.readFile(path)))
    } catch {
      // fichier illisible : ignoré
    }
  }
  for (const dir of RULE_DIRS) {
    const abs = join(root, dir)
    try {
      if (!(await window.api.fs.exists(abs))) continue
      for (const e of await window.api.fs.readDir(abs)) {
        if (e.isDirectory || !/\.(mdc|md)$/i.test(e.name)) continue
        rules.push(parseRule(`${dir}/${e.name}`, await window.api.fs.readFile(e.path)))
      }
    } catch {
      // dossier illisible : ignoré
    }
  }
  return rules
}

/**
 * Section « règles » à ajouter au prompt système, selon les fichiers concernés
 * (chemins absolus). Les règles « à la demande » ne sont listées que pour l'agent.
 */
export async function rulesSection(files: string[], opts: { listAvailable?: boolean } = {}): Promise<{ text: string; count: number }> {
  const { workspace, settings } = useIde.getState()
  const rules = workspace ? await loadProjectRules(workspace) : []
  const rel = files.filter((f) => workspace && isInside(workspace, f)).map((f) => relative(workspace!, f).split('\\').join('/'))
  const { applied, available } = selectRules(rules, rel)
  const text = rulesPrompt(settings.userRules, applied, opts.listAvailable ? available : [])
  return { text, count: applied.length + (settings.userRules.trim() ? 1 : 0) }
}
