import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const manifestPath = path.join(root, '.codex-plugin', 'plugin.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const required = ['name', 'version', 'description', 'author', 'skills', 'interface']
for (const field of required) if (!(field in manifest)) throw new Error(`Missing manifest field: ${field}`)
if (manifest.name !== path.basename(root)) throw new Error('Manifest name must match plugin directory')
if (!manifest.author?.name) throw new Error('Manifest author.name is required')
for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt']) {
  if (!(field in manifest.interface)) throw new Error(`Missing interface field: ${field}`)
}
if (!fs.existsSync(path.join(root, 'skills'))) throw new Error('skills directory is required')
console.log(`Validated ${manifest.name} ${manifest.version}`)
