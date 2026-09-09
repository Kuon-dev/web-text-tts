import { FileAudio } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { EngineModeList } from "@/components/EngineModePicker"
import { VoiceCombobox } from "@/components/VoiceCombobox"
import { uploadClone } from "@/lib/api"
import { player, usePlayer } from "@/lib/player"
import { DropZone, SectionHeader, SettingRow } from "./controls"

export function VoiceSection() {
  const { voice, voices, engine, instruct } = usePlayer()
  const isQwen3 = engine?.engine === "qwen3"

  const onClone = async (f: File) => {
    const name = f.name.replace(/\.[^.]+$/, "")
    try {
      await uploadClone(name, await f.arrayBuffer())
      await player.refreshVoices()
      toast.success(`Voice "${name}" added`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    }
  }

  return (
    <>
      <SectionHeader title="Voice" description="Who reads, and on which hardware." />
      <SettingRow label="Narrator" description="Grouped by engine and language. Cloned voices appear under Cloned.">
        <VoiceCombobox voice={voice} voices={voices} className="w-full" />
      </SettingRow>
      <EngineModeList engine={engine} />
      {isQwen3 && (
        <>
          <SettingRow label="Style instruction" description="Applies to preset voices. Changing it regenerates audio." htmlFor="instruct">
            <Input
              id="instruct"
              placeholder='e.g. "read calmly, slightly tired"'
              defaultValue={instruct}
              onBlur={(e) => {
                if (e.target.value !== instruct) void player.setInstruct(e.target.value)
              }}
            />
          </SettingRow>
          <SettingRow label="Clone a voice">
            <DropZone
              Icon={FileAudio}
              label="Add a reference clip"
              hint="3–30 s clip of one speaker · wav, flac or ogg"
              accept="audio/*"
              onFile={(f) => void onClone(f)}
            />
          </SettingRow>
        </>
      )}
    </>
  )
}
