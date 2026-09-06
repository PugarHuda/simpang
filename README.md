# SIMPANG

**Kamu yang memilih arah di tiap simpang.** Simpang = titik jalan bercabang.
Selagi agent berpikir, kamulah branch predictor-nya.

Entry untuk hackathon Commons · *Make the wait worth it*.

---

## Tesis

> Waktu tunggu adalah thread kedua. Apa pun yang terjadi di sana harus berakhir
> masuk ke thread utama.

Semua orang menaruh **sesuatu di sebelah** loading screen. SIMPANG menaruh
sesuatu yang **menyatu kembali ke dalamnya**.

CPU punya istilah untuk masalah ini: *wait state*, siklus di mana prosesor diam
menunggu memori lambat. Solusinya di silikon adalah **speculative execution**
dan **branch prediction**. Agent AI punya wait state yang sama — tapi tidak
punya branch predictor. Inversinya: **manusialah branch predictor-nya.**

## Cara kerjanya

1. Kamu tekan Enter. Main run mulai: agent (Claude Sonnet 5) membaca repo
   sungguhan di disk dan menulis file ke working copy per run.
2. **Bersamaan**, model murah menjalankan *divergence scan*: titik-titik
   keputusan di mana agent yang kompeten bisa wajar-wajar saja memilih dua arah.
3. Tiap cabang dirender satu baris: label, jumlah file, biaya, keyakinan.
4. Kamu memangkas. `1-6` kill · `⇧1-6` pin · `space` ask lalu `y`/`n` · `esc`
   ignore · `f` fork (kalau terlambat) · `enter` bayar cabang ke-4+ via x402 ·
   `tab` pangkas pohon orang lain · `d` lihat diff.
5. Tiap pangkasan masuk ke antrian steering, **di-drain di batas tool call
   berikutnya** dan menimpa instruksi agent — bukan di turn berikutnya.
6. Cabang yang tidak kamu bunuh **tidak mati**: cabang alternatif dihitung
   sungguhan oleh model kedua selama kamu menunggu, dan jadi follow-up siap
   pakai saat jawaban utama mendarat.
7. Setelah selesai: diff nyata (`git diff`), skor kalibrasi tebakanmu vs yang
   diambil main run, dan preferensi yang kamu bunuh 3× berhenti ditanyakan
   (persisten di `.simpang/prior.json`).

Tidak ada mode mock, fixture palsu, atau pembayaran demo. Semua yang terlihat
adalah model, file, dan facilitator sungguhan.

## Jalankan

```bash
npm install
echo "VENICE_API_KEY=..." > .env.local     # atau OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
npm run dev                                 # http://localhost:3000
```

Port 3000 bentrok? `PORT=3100 npm run dev`. Variabel lain: lihat `.env.example`.
Next 16 hanya mengizinkan satu dev server per folder.

**Model.** Main run `claude-sonnet-5`; scan `openai-gpt-56-luna`. Diukur di
Venice (2026-09-06) dengan prompt scan sungguhan: luna 18 s / 5 divergensi
relevan; gpt-4o-mini 4 s tapi menawarkan pilihan yang sudah dibuat prompt;
deepseek/gemma berpikir dulu 10-30 s; claude-sonnet-5 22 s dan mahal. Timpa
lewat `SIMPANG_MAIN_MODEL` / `SIMPANG_SCAN_MODEL`.

**Repo.** Default `examples/acme` (aplikasi kecil dengan auth JWT). Tunjuk repo
lain lewat `SIMPANG_REPO_DIR`. Agent membaca dan menulis di salinan per run
(`.simpang/runs/<id>/`); repo asli tidak pernah disentuh.

## Gerbang bayar x402

Scan menghasilkan sampai 5 divergensi. Tiga pertama gratis; tiap divergensi
berikutnya 0.01 USDC lewat **x402 v2 dengan SDK resmi**:

- Penjual: `app/api/unlock/route.ts` dibungkus `withX402` dari `@x402/next`;
  `x402ResourceServer` + `HTTPFacilitatorClient` + `ExactEvmScheme`.
- Pembeli (browser): `lib/x402-client.ts` memakai `@x402/fetch` +
  `@x402/evm` + viem. Wallet EVM (MetaMask, Rabby, Coinbase Wallet)
  menandatangani EIP-3009 `TransferWithAuthorization`; `wrapFetchWithPayment`
  mengulang request dengan `PAYMENT-SIGNATURE`; facilitator men-settle transfer
  USDC on-chain dan membalas `PAYMENT-RESPONSE` berisi hash transaksi.
- Default **Base Sepolia** + USDC testnet + facilitator `https://x402.org/facilitator`.
  Mainnet Base: `X402_NETWORK=eip155:8453` dan facilitator CDP Coinbase.
- Tanpa wallet di browser, UI bilang butuh wallet. Tidak ada jalur demo.
- `steer` ke divergensi yang terkunci ditolak 402 di server, bukan hanya
  disembunyikan UI.

## Cek

Semua tes melawan model dan facilitator sungguhan (~$0.03 per run dengan
`qwen3-coder` sebagai main run). Butuh `VENICE_API_KEY`.

```bash
npm test          # Playwright: menyalakan server sendiri di :3101 (matikan dev server lain dulu)
```

Empat skenario e2e (`tests/e2e.spec.ts`):

1. **Kill mengubah eksekusi.** Tekan `1` → toast berisi constraint dari scan
   dalam < 1 detik → main run commit ke cabang lawan → kalibrasi 100% → diff
   nyata dengan header `a/<file> b/<file>`. Sambil menunggu: ask mode, collapse,
   activity line.
2. **Pangkasan terlambat tidak menguap.** Bunuh cabang yang sudah dimenangkan →
   `late` → `f` → agent merevisi di working copy yang sama, diff diperbarui.
3. **Pohon multiplayer.** Dua browser; `tab` di satu mengambil pohon yang lain;
   pangkasannya masuk ke antrian steering run mereka.
4. **x402 dengan wallet asli.** `window.ethereum` diisi wallet viem (kunci baru,
   saldo 0). `enter` → 402 → tanda tangan EIP-3009 sah → facilitator x402.org
   menolak dengan `invalid_exact_evm_insufficient_balance`, bukan karena tanda
   tangan. Isi kunci itu dengan USDC Base Sepolia dan hasilnya `paid`.

```bash
SIMPANG_FREE_BRANCHES=2 npx next dev -p 3101 &
BASE=http://localhost:3101 npm run test:api     # tanpa browser: validasi, scan, steer, x402, diff, kalibrasi
```

## Peta file

| File | Isi |
|---|---|
| `lib/divergence.ts` | Schema polos + prompt scan + **quality gate deterministik** |
| `lib/store.ts` | Antrian steering, aksi user, unlock count, prior persisten |
| `lib/config.ts` | Pagar biaya & latensi · provider model · parameter x402 |
| `lib/repo.ts` | Repo di disk, working copy per run, `git diff` nyata |
| `lib/x402.ts` | Resource server x402 (SDK resmi) |
| `lib/x402-client.ts` | Pembeli x402 di browser: wallet EVM + `@x402/fetch` |
| `app/api/run/route.ts` | SSE · scan paralel · agent loop · `prepareStep` = titik injeksi · prefetch · classifier |
| `app/api/steer/route.ts` | kill / pin — **tanpa panggilan model** |
| `app/api/fork/route.ts` | Fork koreksi di working copy yang sama |
| `app/api/unlock/route.ts` | Gerbang x402 (`withX402`) untuk divergensi ke-4+ |
| `app/api/others/route.ts` | State run (dipoll UI) + pohon multiplayer |
| `components/tree.tsx` | Pohon + hotkey |
| `examples/acme/` | Repo contoh yang dikerjakan agent |
| `tests/` | Playwright e2e + tes API |

## Keputusan desain yang penting

**`constraintIfPinned` / `constraintIfKilled` dibuat di scan yang sama.**
Menekan `1` tidak memicu panggilan model apa pun — teks constraint-nya sudah
ada. Itulah cara memenuhi aturan UX "efek terlihat < 1 detik".

**Steering masuk lewat `instructions` per step.** AI SDK 7 menolak pesan
`system` di tengah `messages`. `prepareStep` menimpa `instructions` dengan
system prompt + semua directive yang sudah masuk, jadi directive bertahan
sampai run selesai.

**Commit adalah tool call, dengan classifier sebagai cadangan.** Main run diberi
tool `decide` ber-enum id divergensi. Model yang mengabaikannya (qwen) tetap
diberi commit: diff dan log-nya diklasifikasikan model scan secara terstruktur
di akhir run. Bukan pencocokan kata kunci.

**Schema scan sengaja polos.** Tanpa `.int()`, `.max()`, atau `z.tuple` —
backend structured-output yang ketat (Anthropic, OpenAI, Gemini, grammar vLLM)
menolak `minimum`/`maxLength`/`items[]`. Batasan ditegakkan di `qualityGate`.

**Quality gate deterministik, bukan harapan pada prompt.** Divergensi dibuang
kalau confidence pemimpinnya ≥ 0.85, kalau kedua confidence tidak berjumlah 1,
kalau labelnya sama, atau id-nya duplikat. Tidak ada yang lolos → **panel tidak
muncul**. Scan juga memperkirakan durasi; wait < 15 s → panel tidak muncul.

**Scan tidak pernah memblokir main run.** Budget 40 s; kalau gagal atau telat,
user cuma melihat loading biasa. Regresi nol.

**Tidak ada aksi user yang menguap.** Tiga tingkat degradasi:

| Situasi | Perilaku |
|---|---|
| Main run masih punya step tersisa | Inject di batas step berikutnya |
| Main run sudah commit ke cabang itu | `late` → `f` fork di working copy yang sama |
| Main run sudah selesai | 409; constraint sudah masuk prior untuk run berikutnya |

**Prefetch sungguhan.** Cabang dengan confidence lebih rendah dari dua
divergensi teratas dihitung model kedua selama menunggu (file yang disentuh +
potongan kode). Dibuang kalau kamu membunuhnya; disembunyikan kalau main run
justru memilihnya.

**User pasif tetap untung.** `esc` menciutkan panel; prefetch tetap jalan;
activity line menunjukkan file yang sedang dibaca/ditulis; diff tetap didapat.

## Roadmap

- [x] Divergence scan + quality gate
- [x] Steering queue + injeksi di `prepareStep`
- [x] Commit via tool `decide` + classifier post-hoc + kalibrasi + prior persisten
- [x] Prefetch sungguhan selama menunggu
- [x] Fork koreksi di working copy
- [x] x402 dengan SDK resmi, wallet browser, facilitator x402.org
- [x] Pohon multiplayer (`[tab]`)
- [x] Repo sungguhan + `git diff`
- [x] Playwright e2e melawan model sungguhan
- [ ] Store multi-instance (Redis) untuk deploy serverless
- [ ] Katalog x402 hackathon di sisi pembeli (URL katalog belum ditemukan)
