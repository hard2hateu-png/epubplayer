const fs = require('fs')

const file = 'src/index.css'
let css = fs.readFileSync(file, 'utf8')
const marker = '/* Pin Now Playing quick-nav to the actual mobile viewport bottom */'

if (!css.includes(marker)) {
  css += `\n\n${marker}\n@media (max-width: 767px) {\n  nav[aria-label="Player navigation"] {\n    position: fixed;\n    left: 0;\n    right: 0;\n    bottom: 0;\n    z-index: 40;\n  }\n}\n`
  fs.writeFileSync(file, css)
  console.log('Pinned player navigation to viewport bottom')
} else {
  console.log('Player navigation bottom pin already applied')
}
