// The page our fetcher's User-Agent links to (VerdictBot/1.0 (+<site>/bot)): what it fetches and how to opt out.
export function BotPage() {
  return (
    <main className="p-4 md:p-8 max-w-2xl mx-auto text-ink-800">
      <h1 className="font-display text-3xl text-ink-900 mb-4">VerdictBot</h1>
      <p className="mb-3">VerdictBot reads product specifications from manufacturers' own websites so Verdict can compare products on the attributes that matter. It:</p>
      <ul className="list-disc ml-5 space-y-1 mb-3">
        <li>fetches only product pages and text-based PDF manuals on a brand's own website, and a brand's home page once to confirm the domain;</li>
        <li>follows robots.txt for the user agent <code>VerdictBot</code>, and any Crawl-delay;</li>
        <li>makes at most one request per second to a site, sends no cookies and never logs in;</li>
        <li>stops when a site refuses (401, 403, 429 or a challenge page) and does not retry for 24 hours;</li>
        <li>does not download or store images, and deletes the page text it reads within 24 hours (only short quotes that back a specification are kept, with a link to the source).</li>
      </ul>
      <p>To opt out, add <code>User-agent: VerdictBot</code> and <code>Disallow: /</code> to your robots.txt.</p>
    </main>
  )
}
