'use client'

/** Without this, one unexpected shape in a response white-screens the whole page and the run is
 *  simply gone. A dead end you can read and retry from is the least a demo owes its visitor. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 font-mono p-6 md:p-10 flex items-center">
      <div className="mx-auto max-w-2xl space-y-4 text-[13px]">
        <div className="text-neutral-100 tracking-widest">SIMPANG</div>
        <div className="text-red-300">✗ the page hit an error it could not recover from</div>
        <p className="text-neutral-400">
          The run itself may have survived: SIMPANG keeps run state on the server, so reloading
          usually brings the tree and the diff back.
        </p>
        <pre className="border border-neutral-900 rounded p-3 text-[12px] text-neutral-500 overflow-x-auto">
          {error.message}{error.digest ? `\n\ndigest ${error.digest}` : ''}
        </pre>
        <div className="flex gap-2">
          <button onClick={reset} className="px-3 py-1 border border-neutral-800 rounded hover:border-neutral-600">
            try again
          </button>
          <a href="/" className="px-3 py-1 border border-neutral-800 rounded hover:border-neutral-600">
            start over
          </a>
        </div>
      </div>
    </main>
  )
}
