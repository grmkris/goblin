import { useEffect, useState } from 'react'
import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  GoblinMark,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@goblin/ui'
import { Check, Code, Moon, Play, RotateCcw, Sun } from 'lucide-react'
import { examples, type Example } from './examples.ts'
import { library } from './library.tsx'
import { maxSourceLength, programProblems } from './program.ts'

const modelPrompt = library.prompt({
  preamble: 'Compose a useful reply using Goblin components.',
  additionalRules: ['Write root first. Use synthetic data. No queries or mutations.'],
})

type Playback = { source: string; shown: number; playing: boolean; revision: number }

/** Chunk replay uses the actual incremental renderer; it never claims to call a model. */
function usePlayback(source: string) {
  const [playback, setPlayback] = useState<Playback>({ source, shown: source.length, playing: false, revision: 0 })
  useEffect(() => {
    if (!playback.playing) return
    const timer = window.setInterval(
      () =>
        setPlayback((current) => {
          const shown = Math.min(current.source.length, current.shown + 28)
          return { ...current, shown, playing: shown < current.source.length }
        }),
      35,
    )
    return () => window.clearInterval(timer)
  }, [playback.playing])
  return { playback, setPlayback }
}

function Receipt({ action }: { readonly action: ActionEvent | undefined }) {
  return (
    <section className="spike-receipt" aria-label="Local action receipt" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Check className="size-4" aria-hidden />
        Local action receipt
      </div>
      {action === undefined ? (
        <p className="text-sm text-muted-foreground">
          Try a button in the reply. Its message and values will appear here.
        </p>
      ) : (
        <>
          <p className="text-sm">{action.humanFriendlyMessage || action.type}</p>
          <pre className="spike-json">
            {JSON.stringify({ type: action.type, params: action.params, formState: action.formState }, null, 2)}
          </pre>
        </>
      )}
      <p className="text-xs text-muted-foreground">Kept in this tab only. No message is sent and no booking is made.</p>
    </section>
  )
}

function usePlayground(example: Example) {
  const [source, setSource] = useState<string>(example.source)
  const [problems, setProblems] = useState<string[]>([])
  const [runtimeErrors, setRuntimeErrors] = useState<OpenUIError[]>([])
  const [action, setAction] = useState<ActionEvent>()
  const { playback, setPlayback } = usePlayback(example.source)
  const render = (stream: boolean) => {
    const errors = programProblems(source)
    setProblems(errors)
    if (errors.length > 0) return
    setRuntimeErrors([])
    setAction(undefined)
    setPlayback((current) => ({
      source,
      shown: stream ? 0 : source.length,
      playing: stream,
      revision: current.revision + 1,
    }))
  }
  const finish = () => setPlayback((current) => ({ ...current, shown: current.source.length, playing: false }))
  const reset = () => {
    setSource(example.source)
    setProblems([])
    setRuntimeErrors([])
    setAction(undefined)
    setPlayback((current) => ({
      source: example.source,
      shown: example.source.length,
      playing: false,
      revision: current.revision + 1,
    }))
  }
  return {
    source,
    setSource,
    problems,
    runtimeErrors,
    setRuntimeErrors,
    action,
    setAction,
    playback,
    render,
    finish,
    reset,
  }
}

function Playground({ example }: { readonly example: Example }) {
  const state = usePlayground(example)
  const { playback, action, setAction, runtimeErrors, setRuntimeErrors } = state
  return (
    <div className="spike-workbench">
      <section className="spike-preview" aria-label="Reply preview">
        <div className="spike-preview-bar">
          <span className="text-sm font-medium">The conversation</span>
          <Badge variant="secondary">{playback.playing ? 'Replaying sample' : 'Sample data'}</Badge>
        </div>
        <div className="spike-conversation">
          <div className="spike-request">
            <span className="text-xs font-medium text-muted-foreground">You</span>
            <p>{example.prompt}</p>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <GoblinMark className="size-5" />
            goblin
          </div>
          <div className="spike-renderer" data-streaming={playback.playing}>
            <Renderer
              key={playback.revision}
              library={library}
              response={playback.source.slice(0, playback.shown)}
              isStreaming={playback.playing}
              onAction={setAction}
              onError={setRuntimeErrors}
            />
          </div>
          {!playback.playing && runtimeErrors.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>The reply needs a correction</AlertTitle>
              <AlertDescription>{runtimeErrors.map((error) => error.message).join(' ')}</AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">{example.hint}</p>
        </div>
        <Receipt action={action} />
      </section>
      <SourceEditor state={state} />
    </div>
  )
}

function SourceEditor({ state }: { readonly state: ReturnType<typeof usePlayground> }) {
  const { source, setSource, problems, playback, render, finish, reset } = state
  return (
    <aside className="spike-editor" aria-label="Playground controls">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => render(true)} disabled={playback.playing}>
          <Play data-icon="inline-start" />
          Replay stream
        </Button>
        <Button variant="outline" onClick={finish} disabled={!playback.playing}>
          Show all
        </Button>
        <Button variant="ghost" size="icon" aria-label="Reset example" onClick={reset}>
          <RotateCcw />
        </Button>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        These examples replay saved OpenUI output through Goblin’s components. Edit the source to try a different reply.
      </p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="source">
            <Code className="size-4" aria-hidden />
            OpenUI source
          </FieldLabel>
          <Textarea
            id="source"
            className="spike-source"
            value={source}
            maxLength={maxSourceLength}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setSource(event.target.value)}
            aria-invalid={problems.length > 0}
            aria-describedby={problems.length > 0 ? 'source-errors' : undefined}
          />
        </Field>
      </FieldGroup>
      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" onClick={() => render(false)}>
          Render code
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">{source.length.toLocaleString()} characters</span>
      </div>
      {problems.length > 0 && (
        <Alert variant="destructive" id="source-errors">
          <AlertTitle>Check the source</AlertTitle>
          <AlertDescription>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <details className="spike-prompt">
        <summary>Component library and model prompt</summary>
        <p className="text-xs text-muted-foreground">
          Generated from the same ten components the preview allows. This spike makes no model calls.
        </p>
        <pre className="spike-json">{modelPrompt}</pre>
      </details>
    </aside>
  )
}

export function App() {
  const [selected, setSelected] = useState<string>(examples[0].id)
  const [dark, setDark] = useState(false)
  const example = examples.find((item) => item.id === selected) ?? examples[0]
  return (
    <div className={dark ? 'dark spike-page' : 'spike-page'}>
      <header className="spike-header">
        <a href="https://github.com/grmkris/goblin" className="spike-brand" target="_blank" rel="noreferrer">
          <GoblinMark className="size-7" />
          <span>goblin</span>
        </a>
        <Badge variant="outline">OpenUI spike</Badge>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon"
          aria-label={dark ? 'Use light theme' : 'Use dark theme'}
          onClick={() => setDark(!dark)}
        >
          {dark ? <Sun /> : <Moon />}
        </Button>
      </header>
      <main className="spike-main">
        <div className="spike-intro">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">A reply you can work with.</h1>
          <p className="text-muted-foreground text-pretty">
            Compare, choose, and fill in the details — right inside the conversation.
          </p>
        </div>
        <Tabs value={selected} onValueChange={setSelected}>
          <TabsList className="spike-tabs">
            {examples.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Playground key={example.id} example={example} />
        <footer className="spike-footer">
          <span>Public preview · synthetic data · OpenUI Lang 1.0.1</span>
          <span>Independent of your Goblin account. Reloading resets the playground.</span>
        </footer>
      </main>
    </div>
  )
}
