import { Pause, Play, SkipBack, SkipForward } from "lucide-react"
import { Button } from "@/components/ui/button"
import { player, usePlayer } from "@/lib/player"
import { Bracket, IconStack } from "./Bracket"

/** Center bracket: the transport, pinned to the exact middle of the bar. */
export function NowPlaying() {
  const { chunks, idx, playing } = usePlayer()
  const n = chunks.length

  return (
    <Bracket label="Playback" delay={0.16} className="justify-self-center">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!n}
        onClick={() => player.jump(idx - 1)}
        title="Previous sentence (←)"
        aria-label="Previous sentence"
      >
        <SkipBack aria-hidden />
      </Button>
      <Button
        size="icon"
        className="relative"
        disabled={!n}
        onClick={() => player.togglePlay()}
        title="Play / pause (Space)"
        aria-label={playing ? "Pause" : "Play"}
      >
        <IconStack active={playing ? "pause" : "play"} icons={{ play: Play, pause: Pause }} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!n}
        onClick={() => player.jump(idx + 1)}
        title="Next sentence (→)"
        aria-label="Next sentence"
      >
        <SkipForward aria-hidden />
      </Button>
    </Bracket>
  )
}
