import { basename, extname } from './paths'

interface IconInfo {
  icon: string
  color: string
}

const BY_EXT: Record<string, IconInfo> = {
  '.ts': { icon: 'file-code', color: '#3178c6' },
  '.tsx': { icon: 'file-code', color: '#3178c6' },
  '.js': { icon: 'file-code', color: '#e8c23a' },
  '.jsx': { icon: 'file-code', color: '#e8c23a' },
  '.mjs': { icon: 'file-code', color: '#e8c23a' },
  '.cjs': { icon: 'file-code', color: '#e8c23a' },
  '.json': { icon: 'json', color: '#cbcb41' },
  '.md': { icon: 'markdown', color: '#519aba' },
  '.mdx': { icon: 'markdown', color: '#519aba' },
  '.css': { icon: 'symbol-color', color: '#42a5f5' },
  '.scss': { icon: 'symbol-color', color: '#f55385' },
  '.less': { icon: 'symbol-color', color: '#42a5f5' },
  '.html': { icon: 'code', color: '#e44d26' },
  '.vue': { icon: 'file-code', color: '#41b883' },
  '.svelte': { icon: 'file-code', color: '#ff3e00' },
  '.py': { icon: 'file-code', color: '#4b8bbe' },
  '.go': { icon: 'file-code', color: '#00add8' },
  '.rs': { icon: 'file-code', color: '#dea584' },
  '.java': { icon: 'file-code', color: '#e76f00' },
  '.kt': { icon: 'file-code', color: '#a97bff' },
  '.c': { icon: 'file-code', color: '#599eff' },
  '.h': { icon: 'file-code', color: '#a074c4' },
  '.cpp': { icon: 'file-code', color: '#599eff' },
  '.cs': { icon: 'file-code', color: '#68217a' },
  '.php': { icon: 'file-code', color: '#8892bf' },
  '.rb': { icon: 'ruby', color: '#cc342d' },
  '.swift': { icon: 'file-code', color: '#f05138' },
  '.dart': { icon: 'file-code', color: '#03589c' },
  '.sh': { icon: 'terminal', color: '#89e051' },
  '.bash': { icon: 'terminal', color: '#89e051' },
  '.zsh': { icon: 'terminal', color: '#89e051' },
  '.ps1': { icon: 'terminal-powershell', color: '#5391fe' },
  '.yml': { icon: 'settings', color: '#cb171e' },
  '.yaml': { icon: 'settings', color: '#cb171e' },
  '.toml': { icon: 'settings', color: '#9c4221' },
  '.ini': { icon: 'settings', color: '#9c9c9c' },
  '.xml': { icon: 'code', color: '#e37933' },
  '.sql': { icon: 'database', color: '#e38c00' },
  '.svg': { icon: 'file-media', color: '#ffb13b' },
  '.png': { icon: 'file-media', color: '#a074c4' },
  '.jpg': { icon: 'file-media', color: '#a074c4' },
  '.jpeg': { icon: 'file-media', color: '#a074c4' },
  '.gif': { icon: 'file-media', color: '#a074c4' },
  '.ico': { icon: 'file-media', color: '#a074c4' },
  '.pdf': { icon: 'file-pdf', color: '#e5252a' },
  '.zip': { icon: 'file-zip', color: '#9c9c9c' },
  '.lock': { icon: 'lock', color: '#9c9c9c' },
  '.txt': { icon: 'file', color: '#9c9c9c' }
}

const BY_NAME: Record<string, IconInfo> = {
  'package.json': { icon: 'package', color: '#cb3837' },
  dockerfile: { icon: 'file-code', color: '#2496ed' },
  '.gitignore': { icon: 'source-control', color: '#f14e32' },
  '.env': { icon: 'key', color: '#ecd53f' },
  license: { icon: 'law', color: '#d0bf41' },
  readme: { icon: 'book', color: '#519aba' },
  '.cursorrules': { icon: 'sparkle', color: '#a78bfa' }
}

export function fileIcon(path: string): IconInfo {
  const name = basename(path).toLowerCase()
  const stem = name.replace(/\.[^.]+$/, '')
  return BY_NAME[name] ?? BY_NAME[stem] ?? (name.startsWith('.env') ? BY_NAME['.env'] : undefined) ?? BY_EXT[extname(name)] ?? { icon: 'file', color: 'var(--fg-muted)' }
}
