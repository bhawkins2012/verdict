import { Outlet } from 'react-router-dom'

export function AuthLayout() {
  return (
    <div className="min-h-screen bg-ink-950 flex">
      {/* Left — branding */}
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-16 relative overflow-hidden">
        {/* Background texture */}
        <div className="absolute inset-0 opacity-5"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
          }}
        />

        <div>
          <h1 className="font-display text-5xl text-white">Verdict</h1>
          <p className="text-ink-400 mt-2 text-lg">Reviews that evolve with you.</p>
        </div>

        <div className="space-y-8">
          {/* Testimonial cards */}
          {[
            { stage: 'First Impression', score: 9, quote: "Absolutely blown away — best espresso machine I've ever used.", product: 'Breville Barista Express' },
            { stage: '1 Year Later', score: 6, quote: "Burr wear and maintenance costs add up. Beautiful machine, but plan for the long-term cost.", product: 'Breville Barista Express' },
          ].map((item, i) => (
            <div key={i} className={`card bg-ink-900 border-ink-800 p-5 ${i === 1 ? 'ml-8' : ''}`}>
              <div className="flex items-center gap-3 mb-3">
                <span className="stage-badge bg-amber-900/40 text-amber-400 border border-amber-800/40">
                  {item.stage}
                </span>
                <span className="font-mono text-amber-400 font-medium">{item.score}/10</span>
              </div>
              <p className="text-ink-300 text-sm italic">"{item.quote}"</p>
              <p className="text-ink-500 text-xs mt-2">{item.product}</p>
            </div>
          ))}
        </div>

        <p className="text-ink-600 text-sm">
          First impressions fade. Track what actually lasts.
        </p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
