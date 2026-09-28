import { isJobAlreadyApplied, addAppliedJob } from '../googleSheets';
import { answerQuestion, resetDobGuessState } from '../questionAnswer';
import { assessJobEligibility } from '../jobEligibility';

export interface BotMetrics {
  successCount: number;
  alreadyAppliedCount: number;
  errorCount: number;
}

export interface SharedLimiter {
  isLimitReached: (platformSuccess: number) => boolean;
  onJobSuccess: () => void;
  getTargetLimit: () => number;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * IMPORTANT — read before tweaking selectors:
 * KitaLulus (www.kitalulus.com) requires a logged-in account to apply, and its apply flow
 * (a multi-step form after clicking "Lamar") only renders once authenticated. This module was
 * built from KitaLulus's public search/listing pages (confirmed real: /lowongan, /lowongan/
 * spec-<kategori>, /lowongan/in-<kota>, /lowongan/detail/<slug>) plus KitaLulus's own published
 * help docs describing the apply flow ("klik Lamar pada detail pekerjaan, isi data diri, klik
 * Selanjutnya"). Unlike the Glints/Jobstreet/LinkedIn/Indeed bots — which were hardened against
 * real runtime logs from actual failed/successful applications — the apply-modal selectors here
 * are a first-draft best effort, since building this without a live authenticated session to
 * inspect means the exact DOM of the logged-in apply modal could not be verified directly.
 * Multiple fallback selectors and text-based (Indonesian) matching are used throughout to
 * maximize the odds of working on the first try, matching the defensive style already used
 * elsewhere in this codebase. If the very first headful/debug run's log shows a selector miss,
 * send that log back — the same iterative fix loop used for the other four platforms applies
 * here too.
 */

export async function runKitaLulusBot(
  page: any,
  config: any,
  onLog: (msg: string) => void,
  sharedLimiter?: SharedLimiter
): Promise<BotMetrics> {
  let successCount = 0;
  let alreadyAppliedCount = 0;
  let errorCount = 0;

  try {
    const keyword = (config.searchKeywords || '').trim();
    const location = (config.location || 'jakarta').trim();

    const toSlug = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    // KitaLulus confirmed URL segments: /lowongan/spec-<kategori-slug> (bidang pekerjaan) and
    // /lowongan/in-<kota-slug> (lokasi). Combining both narrows to keyword+location; if the
    // exact category slug doesn't exist KitaLulus falls back to its own "0 lowongan" empty
    // state gracefully (handled below) rather than erroring.
    const keywordSlug = keyword ? toSlug(keyword) : '';
    const locationSlug = location ? toSlug(location) : '';
    let searchUrl = 'https://www.kitalulus.com/lowongan';
    if (keywordSlug && locationSlug) {
      searchUrl = `https://www.kitalulus.com/lowongan/spec-${keywordSlug}/in-${locationSlug}`;
    } else if (keywordSlug) {
      searchUrl = `https://www.kitalulus.com/lowongan/spec-${keywordSlug}`;
    } else if (locationSlug) {
      searchUrl = `https://www.kitalulus.com/lowongan/in-${locationSlug}`;
    }

    onLog(`🌐 Membuka URL Pencarian KitaLulus: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    // Jika kombinasi kategori+kota tidak dikenali KitaLulus (404 / "Lowongan Belum Tersedia"),
    // mundur ke pencarian berbasis kata kunci bebas lewat kotak pencarian di halaman utama
    // /lowongan, yang selalu tersedia terlepas dari slug apa pun.
    const pageState = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const isEmpty = /Lowongan Belum Tersedia|halaman tidak ditemukan|404/i.test(bodyText);
      return { isEmpty, title: document.title };
    });

    if (pageState.isEmpty && keyword) {
      onLog(`ℹ️ Kombinasi kategori/lokasi tidak dikenali KitaLulus, mencoba kotak pencarian manual di halaman utama...`);
      await page.goto('https://www.kitalulus.com/lowongan', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      const searchApplied = await page.evaluate((kw: string) => {
        const input = document.querySelector(
          'input[type="search"], input[placeholder*="Cari"], input[placeholder*="posisi"], input[name*="search"], input[name*="keyword"]'
        ) as HTMLInputElement | null;
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, kw); else input.value = kw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, keyword);
      if (searchApplied) {
        await page.keyboard.press('Enter').catch(() => {});
        await sleep(2500);
      }
    }

    // 1. Pengecekan status login. KitaLulus menampilkan tombol "Masuk" di navbar saat belum
    // login, dan sebaliknya nama pengguna/avatar saat sudah login.
    const isLoggedIn = await page.evaluate(() => {
      const loginBtn = Array.from(document.querySelectorAll('a, button')).find(el =>
        /^Masuk$/i.test((el.textContent || '').trim())
      );
      const accountMenu = document.querySelector('[data-testid*="account"], [data-testid*="profile"], [class*="UserMenu"], [class*="user-menu"]');
      return !loginBtn || !!accountMenu;
    });

    if (!isLoggedIn) {
      onLog('⚠️ KitaLulus: Belum login! Silakan klik tombol "Buka Browser (Login Setup)" di Dashboard untuk login KitaLulus terlebih dahulu.');
      return { successCount, alreadyAppliedCount, errorCount };
    }
    onLog('✅ KitaLulus: Sesi login terdeteksi aktif.');

    let currentPage = 1;
    const maxPages = 5;
    const targetLimit = sharedLimiter ? sharedLimiter.getTargetLimit() : (config.limitKitaLulus || config.limitPerDay || 20);
    const checkLimitReached = () => sharedLimiter ? sharedLimiter.isLimitReached(successCount) : successCount >= targetLimit;

    while (currentPage <= maxPages && global.isBotRunning !== false && !checkLimitReached()) {
      if (currentPage > 1) {
        const pageUrl = `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}page=${currentPage}`;
        onLog(`📄 Membuka Halaman Pencarian KitaLulus ke-${currentPage}: ${pageUrl}`);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(2500);
      }

      // 2. Kumpulkan kartu lowongan dari halaman listing.
      const jobCards: Array<{ url: string; title: string; company: string }> = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/lowongan/detail/"]')) as HTMLAnchorElement[];
        const seen = new Set<string>();
        const results: Array<{ url: string; title: string; company: string }> = [];
        for (const a of anchors) {
          const href = a.href;
          if (seen.has(href)) continue;
          seen.add(href);
          const card = a.closest('[class*="card"], article, li') || a;
          const text = (card.textContent || '').trim();
          // Kartu KitaLulus umumnya merangkai "Judul PosisiNama PerusahaanDipromosikan..." tanpa
          // pemisah jelas di textContent gabungan; ambil judul dari elemen heading pertama bila
          // ada, dan nama perusahaan dari baris kedua, dengan fallback ke potongan teks kasar.
          const heading = card.querySelector('h2, h3, [class*="title"]');
          const title = (heading?.textContent || text.slice(0, 60)).trim();
          const companyEl = card.querySelector('[class*="company"], [class*="Company"]');
          const company = (companyEl?.textContent || '').trim() || 'Perusahaan KitaLulus';
          results.push({ url: href.split('?')[0], title: title || 'Lowongan KitaLulus', company });
        }
        return results;
      });

      if (jobCards.length === 0) {
        onLog(`📊 Halaman ${currentPage}: Tidak ditemukan lowongan. Menghentikan pencarian.`);
        break;
      }
      onLog(`📊 Halaman ${currentPage}: Ditemukan ${jobCards.length} lowongan untuk diproses.`);

      // 3. Proses tiap lowongan secara berurutan di tab yang sama (single worker) — lebih aman
      // untuk platform baru yang belum teruji dibanding langsung memakai 2 worker concurrent
      // seperti platform lain; bisa dinaikkan setelah selector terbukti stabil dari log nyata.
      for (const job of jobCards) {
        if (!global.isBotRunning || checkLimitReached()) break;
        resetDobGuessState();

        try {
          const already = await isJobAlreadyApplied(job.url, config);
          if (already) {
            onLog(`⏩ Already applied (skipped): ${job.url}`);
            alreadyAppliedCount++;
            continue;
          }

          onLog(`🔗 Opening Job: ${job.url}`);
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(2000);

          const detail = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const title = (h1?.textContent || '').trim();
            const companyEl = document.querySelector('[class*="company"], [class*="Company"], a[href*="/company/"]');
            const company = (companyEl?.textContent || '').trim();
            const descEl = document.querySelector('[class*="description"], [class*="Description"], [class*="detail-content"], main article') || document.body;
            const description = (descEl.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 15000);
            return { title, company, description };
          });
          const activeTitle = detail.title || job.title;
          const activeCompany = detail.company || job.company;
          onLog(`💼 Job: "${activeTitle}" at "${activeCompany}"`);

          // Eligibility gate: konsisten dengan Glints/Jobstreet/LinkedIn — hanya lanjut kalau
          // profil/CV yang dikonfigurasi mendukung lowongan ini (atau eligibility check
          // dimatikan lewat toggle di Konfigurasi Bot).
          const eligibility = await assessJobEligibility(activeTitle, activeCompany, detail.description, config, onLog);
          onLog(`🧭 Eligibility: ${eligibility.eligible ? 'ELIGIBLE' : 'SKIP'} (confidence ${Math.round(eligibility.confidence * 100)}%)`);
          if (!eligibility.eligible) {
            onLog(`⏩ Dilewati karena eligibility tidak cukup: ${[...eligibility.reasons, ...eligibility.missingRequirements].join(' | ')}`);
            alreadyAppliedCount++;
            continue;
          }

          // 4. Klik tombol "Lamar" / "Lamar Sekarang" — dengan cakupan selector yang lebih luas
          // (teks, data-testid, class) karena ini satu-satunya bot yang belum pernah diverifikasi
          // terhadap sesi live berhasil melamar; kalau pola teks tombol KitaLulus ternyata beda
          // dari dugaan awal, log di bawah ini akan menunjukkan persis di titik mana ia berhenti.
          const applyClicked = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
            const btn = candidates.find(el => {
              const txt = (el.textContent || '').trim();
              const attrs = `${el.getAttribute('data-testid') || ''} ${el.className || ''}`.toLowerCase();
              return /^lamar(\s+sekarang|\s+pekerjaan)?$/i.test(txt) || /apply/i.test(txt) || /apply-btn|apply-button|btn-apply|lamar/i.test(attrs);
            });
            if (btn) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return { clicked: true, buttonText: (btn.textContent || '').trim() };
            }
            return { clicked: false, buttonText: '' };
          });

          if (!applyClicked.clicked) {
            onLog(`⏩ Melewati "${activeTitle}" — Tombol 'Lamar' tidak ditemukan (kemungkinan sudah dilamar, lowongan ditutup, atau selector perlu disesuaikan — kirim log ini untuk diperbaiki).`);
            continue;
          }

          onLog(`🖱️ Mengklik tombol "${applyClicked.buttonText || 'Lamar'}"...`);
          await sleep(2500);

          // KitaLulus mungkin membuka form lamaran di TAB BARU alih-alih modal di tab yang sama
          // (pola umum di banyak job portal). Deteksi dan pindah fokus ke tab baru itu bila ada.
          const pagesAfterClick = await page.browser().pages();
          let applyPage = page;
          if (pagesAfterClick.length > 1) {
            const newest = pagesAfterClick[pagesAfterClick.length - 1];
            if (newest !== page) {
              onLog('🟢 Formulir lamaran terbuka di tab baru.');
              applyPage = newest;
              await applyPage.bringToFront().catch(() => {});
              await sleep(1500);
            }
          }

          // 5. Solver step generik untuk modal/halaman lamaran multi-langkah, memakai mesin
          // jawaban yang sama dengan platform lain (answerQuestion) agar konsisten membaca
          // profil & CV yang sudah dikonfigurasi.
          let step = 1;
          let finished = false;
          while (step <= 8 && global.isBotRunning) {
            await sleep(1500);

            const formState = await applyPage.evaluate(() => {
              const container = document.querySelector('[role="dialog"], .modal, [class*="Modal"], main') || document.body;
              const bodyText = container.textContent || '';
              const isSuccess = /berhasil dikirim|lamaran terkirim|berhasil melamar|application submitted|terima kasih telah melamar/i.test(bodyText);

              const questions: { question: string; type: string; options: string[]; inputSelector: string; isFilled: boolean }[] = [];

              const radioGroups = Array.from(container.querySelectorAll('fieldset, [role="radiogroup"]'));
              for (const fs of radioGroups) {
                const legend = (fs.querySelector('legend, label, h3, h4')?.textContent || '').trim().replace(/\s+/g, ' ');
                const radios = Array.from(fs.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
                if (!legend || radios.length === 0) continue;
                const options = radios.map(r => {
                  const lbl = fs.querySelector(`label[for="${r.id}"]`) || r.closest('label');
                  return (lbl?.textContent || r.value || '').trim();
                }).filter(Boolean);
                questions.push({
                  question: legend,
                  type: 'radiobutton',
                  options,
                  inputSelector: radios[0].name ? `input[name="${radios[0].name}"]` : 'input[type="radio"]',
                  isFilled: radios.some(r => r.checked),
                });
              }

              const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
              for (const sel of selects) {
                const label = container.querySelector(`label[for="${sel.id}"]`) || sel.closest('div')?.querySelector('label');
                const qText = (label?.textContent || sel.getAttribute('aria-label') || 'Dropdown').trim();
                const options = Array.from(sel.options).map(o => o.text.trim()).filter(Boolean);
                questions.push({
                  question: qText,
                  type: 'dropdown',
                  options,
                  inputSelector: sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`,
                  isFilled: !!sel.value && sel.selectedIndex > 0,
                });
              }

              const textInputs = Array.from(container.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], textarea')) as (HTMLInputElement | HTMLTextAreaElement)[];
              for (const inp of textInputs) {
                if ((inp as HTMLInputElement).type === 'file') continue;
                const label = container.querySelector(`label[for="${inp.id}"]`) || inp.closest('div')?.querySelector('label');
                const qText = (label?.textContent || inp.placeholder || 'Pertanyaan').trim();
                if (questions.some(q => q.question === qText)) continue;
                questions.push({
                  question: qText,
                  type: 'text',
                  options: [],
                  inputSelector: inp.id ? `#${inp.id}` : (inp.name ? `[name="${inp.name}"]` : 'input'),
                  isFilled: !!(inp.value || '').trim(),
                });
              }

              const nextBtn = Array.from(container.querySelectorAll('button')).find(b =>
                /^(Selanjutnya|Lanjutkan|Berikutnya|Next)$/i.test((b.textContent || '').trim())
              ) as HTMLElement | undefined;
              const submitBtn = Array.from(container.querySelectorAll('button')).find(b =>
                /^(Kirim|Kirim Lamaran|Submit|Selesai)$/i.test((b.textContent || '').trim())
              ) as HTMLElement | undefined;

              return {
                isSuccess,
                questions: questions.filter(q => !q.isFilled),
                hasNext: !!nextBtn,
                hasSubmit: !!submitBtn,
              };
            });

            if (formState.isSuccess) {
              onLog(`🎉 Berhasil melamar pekerjaan: ${activeTitle}`);
              await addAppliedJob({ company: activeCompany, title: activeTitle, platform: 'KitaLulus', jobUrl: job.url, status: 'Berhasil' }, config);
              successCount++;
              if (sharedLimiter) sharedLimiter.onJobSuccess();
              finished = true;
              break;
            }

            if (formState.questions.length > 0) {
              for (const qItem of formState.questions) {
                onLog(`📋 Pertanyaan (${qItem.type.toUpperCase()}): "${qItem.question}"`);
                const chosenAnswers = await answerQuestion(qItem.question, qItem.options, qItem.type as any, config, true);
                onLog(`🤖 Keputusan Jawaban: [${chosenAnswers.join(' | ')}]`);
                if (chosenAnswers.length === 0) continue;

                await applyPage.evaluate((targetQ: any, answers: string[]) => {
                  if (targetQ.type === 'radiobutton') {
                    const radios = Array.from(document.querySelectorAll(targetQ.inputSelector)) as HTMLInputElement[];
                    for (const r of radios) {
                      const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
                      const txt = (lbl?.textContent || r.value || '').trim();
                      if (txt.toLowerCase().includes(answers[0].toLowerCase()) || answers[0].toLowerCase().includes(txt.toLowerCase())) {
                        (lbl as HTMLElement || r).click();
                        r.checked = true;
                        r.dispatchEvent(new Event('change', { bubbles: true }));
                        break;
                      }
                    }
                  } else if (targetQ.type === 'dropdown') {
                    const sel = document.querySelector(targetQ.inputSelector) as HTMLSelectElement;
                    if (sel) {
                      const opt = Array.from(sel.options).find(o => o.text.trim().toLowerCase() === answers[0].toLowerCase());
                      sel.value = opt ? opt.value : sel.value;
                      sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  } else if (targetQ.type === 'text') {
                    const el = document.querySelector(targetQ.inputSelector) as HTMLInputElement;
                    if (el && el.type !== 'file') {
                      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                      if (setter) setter.call(el, answers[0]); else el.value = answers[0];
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                }, qItem, chosenAnswers);
                await sleep(300);
              }
              await sleep(500);
            }

            if (formState.hasSubmit) {
              if (config.debugTest) {
                onLog(`📝 [Dry-run Sim] Data simulasi "${activeCompany}" (${activeTitle}) dicatat ke Google Sheets — tombol Kirim TIDAK diklik (Debug Mode aktif).`);
                await addAppliedJob({ company: activeCompany, title: activeTitle, platform: 'KitaLulus', jobUrl: job.url, status: 'Dry-run Sim' }, config);
                successCount++;
                if (sharedLimiter) sharedLimiter.onJobSuccess();
                finished = true;
                break;
              }
              await applyPage.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b =>
                  /^(Kirim|Kirim Lamaran|Submit|Selesai)$/i.test((b.textContent || '').trim())
                ) as HTMLElement | undefined;
                btn?.click();
              });
              await sleep(2000);
            } else if (formState.hasNext) {
              await applyPage.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b =>
                  /^(Selanjutnya|Lanjutkan|Berikutnya|Next)$/i.test((b.textContent || '').trim())
                ) as HTMLElement | undefined;
                btn?.click();
              });
              onLog(`👉 Mengklik tombol "Selanjutnya"...`);
              await sleep(1500);
            } else if (formState.questions.length === 0) {
              // Tidak ada pertanyaan tersisa, tidak ada tombol Next/Submit terdeteksi — anggap
              // form sudah pada langkah terakhir yang butuh interaksi manual/selector belum
              // dikenali; hentikan loop dengan aman daripada berputar tanpa progres.
              break;
            }

            step++;
          }

          if (!finished) {
            onLog(`⚠️ Form KitaLulus untuk "${activeTitle}" tidak terkonfirmasi selesai setelah ${step - 1} langkah. Kemungkinan perlu penyesuaian selector — lewati untuk sekarang.`);
          }

          if (applyPage !== page && !applyPage.isClosed()) {
            await applyPage.close().catch(() => {});
          }
        } catch (itemErr: any) {
          onLog(`❌ Error applying to job ${job.url}: ${itemErr.message || itemErr}`);
          errorCount++;
        }

        await sleep(1200);
      }

      currentPage++;
    }

    if (checkLimitReached()) {
      onLog(`🎯 Batas kuota tercapai (${successCount}/${targetLimit}). Selesai.`);
    }
  } catch (err: any) {
    onLog(`❌ Error fatal pada bot KitaLulus: ${err.message || err}`);
    errorCount++;
  }

  return { successCount, alreadyAppliedCount, errorCount };
}
