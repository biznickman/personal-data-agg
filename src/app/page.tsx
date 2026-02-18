export default function Home() {
  return (
    <main className="min-h-screen p-8 bg-gray-950 text-white">
      <h1 className="text-3xl font-bold mb-4">🔄 Ingestion Engine</h1>
      <p className="text-gray-400 mb-8">
        Deterministic data ingestion for the OpenClaw system. No AI, no
        browsers, just APIs → Supabase.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-lg font-semibold mb-2">📰 X News Ingest</h2>
          <p className="text-gray-400 text-sm">
            49 source accounts → Supabase tweets table
          </p>
          <p className="text-gray-500 text-xs mt-2">Every 15 minutes</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-lg font-semibold mb-2">🔑 X Keyword Scan</h2>
          <p className="text-gray-400 text-sm">
            Crypto keyword search → Supabase tweets table
          </p>
          <p className="text-gray-500 text-xs mt-2">Every hour</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-lg font-semibold mb-2">🎙️ Granola Notes</h2>
          <p className="text-gray-400 text-sm">
            Meeting notes → Supabase voice_notes table
          </p>
          <p className="text-gray-500 text-xs mt-2">Every 30 minutes</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-lg font-semibold mb-2">💬 Message Log</h2>
          <p className="text-gray-400 text-sm">
            Session transcripts → Supabase message_log table
          </p>
          <p className="text-gray-500 text-xs mt-2">Every 30 minutes</p>
        </div>
      </div>

      <div className="mt-8 text-gray-600 text-sm">
        <p>
          Dashboard:{" "}
          <a
            href="http://localhost:8288"
            className="text-blue-400 hover:underline"
          >
            Inngest Dev Server →
          </a>
        </p>
      </div>
    </main>
  );
}
