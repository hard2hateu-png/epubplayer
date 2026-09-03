const fs = require('fs')

const path = 'src/features/player/NowPlayingPage.tsx'
let source = fs.readFileSync(path, 'utf8')

const stateAnchor = `  const [dragProgress, setDragProgress] = useState(0)\n  const progressBarRef = useRef<HTMLDivElement>(null)`
const stateReplacement = `  const [dragProgress, setDragProgress] = useState(0)\n  const [coverLoaded, setCoverLoaded] = useState(false)\n  const progressBarRef = useRef<HTMLDivElement>(null)\n\n  // A cover blob URL can briefly be unavailable while the app refreshes it\n  // from IndexedDB after a reload. Keep the neutral placeholder visible until\n  // the refreshed image has actually loaded instead of flashing a broken icon.\n  useEffect(() => {\n    setCoverLoaded(false)\n  }, [currentBook?.coverUrl])`

if (!source.includes(stateAnchor)) throw new Error('State anchor not found')
source = source.replace(stateAnchor, stateReplacement)

const coverBlock = `                  <div className="aspect-square h-[min(32vh,16rem)] w-auto max-h-full max-w-full overflow-hidden rounded-2xl bg-surface-3 shadow-2xl shadow-black/50 lg:h-auto lg:w-full lg:rounded-3xl">\n                    {currentBook.coverUrl ? (\n                      <img\n                        src={currentBook.coverUrl}\n                        alt={currentBook.title}\n                        className="h-full w-full object-cover"\n                      />\n                    ) : (\n                      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/20 to-purple-900/30">\n                        <span className="text-6xl opacity-50 lg:text-8xl">📖</span>\n                      </div>\n                    )}\n                  </div>`

const coverReplacement = `                  <div className="relative aspect-square h-[min(32vh,16rem)] w-auto max-h-full max-w-full overflow-hidden rounded-2xl bg-surface-3 shadow-2xl shadow-black/50 lg:h-auto lg:w-full lg:rounded-3xl">\n                    <div\n                      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent/20 to-purple-900/30"\n                      aria-hidden="true"\n                    >\n                      <span className="text-6xl opacity-50 lg:text-8xl">📖</span>\n                    </div>\n                    {currentBook.coverUrl && (\n                      <img\n                        src={currentBook.coverUrl}\n                        alt={currentBook.title}\n                        onLoad={() => setCoverLoaded(true)}\n                        onError={() => setCoverLoaded(false)}\n                        className={\`relative h-full w-full object-cover transition-opacity duration-150 \${coverLoaded ? 'opacity-100' : 'opacity-0'}\`}\n                      />\n                    )}\n                  </div>`

if (!source.includes(coverBlock)) throw new Error('Cover block not found')
source = source.replace(coverBlock, coverReplacement)

fs.writeFileSync(path, source)
console.log('Applied cover load placeholder patch')
// Trigger workflow after workflow installation.
