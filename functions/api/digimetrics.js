// Cloudflare Pages Function — DIGIMETRICS schedule/game/results proxy.
// Date validation is fail-closed: no unverified calendar is returned as today's games.
const ORIGIN = "https://estadisticas.lidom.com";

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "schedule";
  const requestedDate = url.searchParams.get("date") || "";
  let target;

  if (view === "schedule") {
    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return json({ ok: false, error: "Fecha solicitada inválida." }, 400);
    }
    target = new URL("/Partido", ORIGIN);
    if (requestedDate) target.searchParams.set("fecha", requestedDate);
  } else if (view === "game") {
    const id = url.searchParams.get("id") || "";
    if (!/^\d{1,10}$/.test(id)) return json({ ok: false, error: "Falta un idPartido válido." }, 400);
    target = new URL("/Partido/Detalle", ORIGIN);
    target.searchParams.set("idPartido", id);
  } else if (view === "results") {
    target = new URL("/Resultado", ORIGIN);
  } else {
    return json({ ok: false, error: "Vista no permitida." }, 400);
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "ScoreBaseballRD/1.0" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow"
    });
    if (!upstream.ok) {
      return json({ ok: false, error: `DIGIMETRICS respondió HTTP ${upstream.status}.`, source: target.toString() }, 502);
    }
    const html = await upstream.text();
    const pageTitle = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,""])[1]).replace(/<[^>]*>/g, "").trim();

    if (view === "schedule" && requestedDate) {
      const pageDate = detectScheduleDate(html);
      if (!pageDate || pageDate !== requestedDate) {
        return json({
          ok: false,
          error: pageDate
            ? "DIGIMETRICS no confirmó la fecha solicitada. Se ocultaron los juegos para no mezclar jornadas."
            : "DIGIMETRICS no expuso un campo de fecha de calendario verificable. Se ocultaron los juegos para evitar mostrar otra jornada.",
          source: target.toString(), requestedDate, pageDate: pageDate || null, pageTitle
        }, 409);
      }
    }

    const gameLinks = view === "schedule"
      ? [...html.matchAll(/href=["']([^"']*Partido\/Detalle\?idPartido=([0-9]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .map(m => ({ href: new URL(m[1].replace(/&amp;/g, "&"), ORIGIN).toString(), id: m[2],
            label: m[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() }))
          .filter((g, i, all) => all.findIndex(x => x.id === g.id) === i)
      : [];

    return json({
      ok: true, view, source: target.toString(), requestedDate: requestedDate || null,
      pageDate: view === "schedule" && requestedDate ? detectScheduleDate(html) : null,
      dateApplied: view === "schedule" && requestedDate ? detectScheduleDate(html) === requestedDate : null,
      fetchedAt: new Date().toISOString(), pageTitle, gameLinks, html
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo consultar DIGIMETRICS.", detail: String(error?.message || error) }, 502);
  }
}

function detectScheduleDate(html) {
  const candidates = [];
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = (attr(tag, "name") || "").toLowerCase();
    const id = (attr(tag, "id") || "").toLowerCase();
    const type = (attr(tag, "type") || "").toLowerCase();
    const value = attr(tag, "value") || "";
    const key = name + " " + id;
    if (/nacimiento|birth|usuario|login/.test(key)) continue;
    if (!/fecha|date|calendario|partido|juego/.test(key)) continue;
    if (type && !["date", "text", "hidden"].includes(type)) continue;
    const parsed = normalizeDate(value);
    if (parsed) candidates.push({ key, parsed });
  }
  candidates.sort((a, b) => score(b.key) - score(a.key));
  return candidates[0]?.parsed || null;
}
function score(key) { return /partido|juego|calendario/.test(key) ? 2 : /fecha|date/.test(key) ? 1 : 0; }
function attr(tag, name) {
  const m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return m ? m[2] : "";
}
function normalizeDate(value) {
  const v = String(value || "").trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return null;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }});
}