# Nostrum — v0 Implementation Milestones

> v0 스코프(`NOSTRUM_DESIGN.md` 참조)를 5단계 수직 슬라이스로 분할한 구현 계획.
> 각 phase는 끝나는 시점에 그 지점까지의 통합/단위 테스트가 가능한 단위이며,
> 앞 phase의 산출물 위에만 의존한다.

---

## Phase 1 — Foundation (`core` + `ndk-adapters`)

**범위**
- 모노레포 스켈레톤: bun workspaces, 루트 `package.json`, 공통 `tsconfig`, 각 패키지의 `exports` 필드
- `@nostrum/core`:
  - 도메인 타입 (`NostrRequest`, `NostrResponse`, `ServerInfo`)
  - `KindSet` + `KINDS_NOSTRUM`, `KINDS_NIP80`
  - `CryptoPort` 인터페이스
- `@nostrum/ndk-adapters`:
  - `NdkCryptoAdapter` 구현 (`wrap` / `unwrapRequest` / `unwrapResponse`)

**Exit criteria**
- `wrap(request) → unwrapRequest` 라운드트립 단위 테스트 통과
- `wrap(response) → unwrapResponse` 라운드트립 단위 테스트 통과
- 잘못된 inner kind / outer kind / 복호화 실패 시 `null` 반환 검증
- `KINDS_NIP80` 로 주입해도 동일하게 동작

---

## Phase 2 — Server minimum viable round-trip

**범위**
- `StoragePort` 인터페이스 + `InMemoryStorageAdapter`
- `CorrelationManager` (순수 로직): `register` (idempotency via `setIfAbsent`), `resolve`, `evictExpired`
- `RelayPort` 인터페이스 + `NdkRelayAdapter` (단일 릴레이, `kinds.wrap` + `#p` 필터)
- `HttpPort` 인터페이스 + `HonoAdapter`
  - `toRequest`: `x-nostrum-principal` 헤더 주입
  - `toNostrResponse`: Hono `Response` → `NostrResponse` 패킹
  - _참고: HTTP 경로 스푸핑 방어(strip)는 Phase 5에서_
- `Nostrum` 컴포지션 루트 + `route()` 미들웨어 (mount marker + runtime gatekeeper)
- `connect()` / `disconnect()` 라이프사이클

**Exit criteria**
- 수동으로 wrap 한 요청 이벤트를 릴레이에 게시하면 대응 Hono 핸들러가 실행되고, 응답이 다시 wrap 되어 릴레이에 게시됨
- `route()` 가 붙지 않은 경로로 요청이 들어오면 501 + `x-nostrum-error: route-not-enabled` 응답
  - _(501 폴백은 Phase 5에서 클라이언트측 핸들링 완성; 서버측 동작은 이 단계에서 완성)_
- 동일 Correlation ID 재수신 시 핸들러 재호출되지 않음 (idempotency)

---

## Phase 3 — Client minimum viable (pin only)

**범위**
- `TransportPort` 인터페이스 + `NdkTransportAdapter` (crypto-agnostic, no secret key)
- `NostrumClient` 컴포지션 루트:
  - `pin(origin, info)` 로 오리진 캐시 pre-seed
  - `fetch(url, init)` — **Nostr 경로만** (HTTPS-first 미구현)
  - 내부 pending-request 맵 + TTL 타이머 + Correlation ID 매칭
  - `wrap` → publish → onEvent → `unwrapResponse` → resolve 파이프라인
- `useTransport` / `useCrypto` 체이닝

**Exit criteria**
- `pin()` 으로 직결된 `NostrumClient` ↔ Phase 2 서버 간 end-to-end 라운드트립
- Hono 핸들러 반환값이 표준 `Response` 로 `fetch()` caller 에 도달
- TTL 초과 시 pending-request 가 reject 되고 맵에서 제거됨
- 본인 앞으로 오지 않은 Correlation ID 이벤트는 무시됨

---

## Phase 4 — Discovery & HTTPS-first dual-mode

**범위**
- **서버**
  - `advertise()` 미들웨어 — `Nostrum-Location` 응답 헤더 주입 (`pubkey`, `relays`, `ma`)
  - `manifest()` 핸들러 — Hono 라우트 테이블을 런타임에 순회하여 `route()` 마커가 있는 라우트만 `/.well-known/nostrum.json` 에 포함
  - `Cache-Control: public, max-age=<ttl>` 설정
- **클라이언트**
  - HTTPS-first 디스패처 (resolution order 1~4: pin → cache → discovery → HTTPS fallback)
  - 오리진 캐시 (`Map<origin, { pubkey, relays, manifest, expiresAt }>`)
  - `Nostrum-Location` 파싱 → 오리진 캐시 populate
  - `/.well-known/nostrum.json` 백그라운드 fetch → 라우트 리스트 저장
  - 매니페스트 기반 `(method, path)` 분기: literal / pattern 매칭
  - `DiscoveryPort` 인터페이스 정의 (어댑터 없음 — 확장점만)
  - `learnFromAdvertisement` 플래그 존중

**Exit criteria**
- `pin()` 없이 HTTPS 첫 호출 후, 두 번째 호출이 자동으로 Nostr 경로로 전환됨
- 매니페스트에 없는 `(method, path)` 는 HTTPS 경로로 처리되고 오리진 캐시에 Nostr-disabled 로 기록됨
- `learnFromAdvertisement: false` 면 `Nostrum-Location` 헤더가 와도 캐시에 들어가지 않음
- 매니페스트 엔드포인트가 `Cache-Control` 헤더와 함께 응답

---

## Phase 5 — Robustness & safety

**범위**
- **런타임 폴백**
  - 클라이언트: `501 + x-nostrum-error: route-not-enabled` 수신 시 해당 `(origin, method, path)` 를 Nostr-disabled 로 마크, 동일 호출을 HTTPS 로 투명 재시도, 백그라운드로 매니페스트 리프레시
- **TTL eviction**
  - 서버: `CorrelationManager.evictExpired` 주기 타이머 (`ttl` 기반)
  - 클라이언트: pending-request 맵 주기 정리
- **스푸핑 방어**
  - `route()` 미들웨어가 plain HTTP 경로에서 인바운드 `x-nostrum-principal` 헤더를 핸들러 도달 전에 strip
  - Nostr 경로에서는 `seal.pubkey` 에서 재계산된 값으로 덮어쓰기 유지
- **Negative caching**
  - Nostrum-aware 가 아닌 오리진도 짧은 TTL 로 캐시하여 매 호출마다 재확인 방지

**Exit criteria**
- 서버 라우트를 제거(또는 `route()` 떼어냄) 후에도 클라이언트가 한 번은 501 을 만나지만 즉시 HTTPS 로 재시도되어 최종 응답이 caller 에게 도달
- plain HTTP 로 `x-nostrum-principal: deadbeef...` 를 넣어 호출하면 핸들러에서 해당 헤더가 보이지 않음
- 만료된 pending/correlation 엔트리가 타이머 tick 이후 맵에서 제거됨
- 비 Nostrum 오리진 재호출 시 네트워크 상 `Nostrum-Location` 재검사가 발생하지 않음 (캐시 TTL 내)

---

## Out of scope for v0

아래 항목은 모두 v1 이며 이 마일스톤 계획에 포함되지 않는다.

- 청크 분할/재조립 (NIP-44 사이즈 제한 초과)
- 다중 릴레이 HA + Correlation ID 기반 dedup
- Redis (또는 기타 공유 KV) `StoragePort` 어댑터
- HTTP fallback `TransportPort` 어댑터
- 외부 discovery 어댑터 구현체 (NIP-05, DNS TXT, 커스텀 디렉터리) — `NOSTRUM_DISCOVERY.md` 참조

---

## Dependency graph (phase 수준)

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
   │           │           │
   └───────────┴───────────┘
   (core / crypto 재사용)
```

- Phase 2 와 Phase 3 은 Phase 1 에만 의존하므로, 동일 코드베이스 안에서는 병렬 작업 가능하지만 통합 테스트는 둘 다 끝나야 성립
- Phase 4 는 Phase 2 + Phase 3 동시 의존
- Phase 5 는 네 단계 모두 위에서만 의미가 있음
