const fs = require('fs')

function replaceInFile(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(oldText)) throw new Error(`Could not find ${label} in ${file}`)
  text = text.replace(oldText, newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label}`)
}

replaceInFile(
  'src/features/library/BookDetailPage.tsx',
`    // Start playback
    await playbackController.play()

    // Navigate to Now Playing
    navigate('/app/playing')`,
`    // Open Now Playing immediately in the reading/highlight view. Do not wait
    // for the generated-audio play promise, which can remain pending for the
    // duration of the current chunk.
    navigate('/app/playing', { state: { reader: true } })

    // Start playback after navigation has been requested. Playback continues
    // independently while the Now Playing screen renders.
    void playbackController.play()`,
  'Continue Listening navigation order'
)

replaceInFile(
  'src/features/player/NowPlayingPage.tsx',
`import { useNavigate } from 'react-router-dom'`,
`import { useNavigate, useLocation } from 'react-router-dom'`,
  'useLocation import'
)

replaceInFile(
  'src/features/player/NowPlayingPage.tsx',
`export function NowPlayingPage() {
  const navigate = useNavigate()`,
`export function NowPlayingPage() {
  const navigate = useNavigate()
  const location = useLocation()`,
  'location hook'
)

replaceInFile(
  'src/features/player/NowPlayingPage.tsx',
`  const [showSpeed, setShowSpeed] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  const [isSlowMode, setIsSlowMode] = useState(false)`,
`  const [showSpeed, setShowSpeed] = useState(false)
  const [showLyrics, setShowLyrics] = useState(
    () => Boolean((location.state as { reader?: boolean } | null)?.reader)
  )
  const [isSlowMode, setIsSlowMode] = useState(false)`,
  'reader view initial state'
)

// Trigger workflow after it exists on main.
