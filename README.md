# BTC Price GNOME

GNOME 상단바에 비트코인 가격을 5초마다 표시합니다.

- **Coinbase**(`BTC-USD`)가 기본 시세입니다. 상단바: `BTC $61,764`
- Coinbase 조회가 실패하거나 재시도 대기 중이면 **Binance**(`BTCUSDT`)를 대신 표시합니다. 상단바: `BTC 61,770 USDT`. Coinbase가 다시 조회 가능해지면 우선 시도합니다.
- 메뉴는 카드 하나입니다. 거래소, 소수점 두 자리 가격, 체결 또는 수신 시각, **Refresh**, **TradingView chart ↗**가 있습니다. 차트는 클릭할 때 브라우저로 열립니다.
- API 키·계정·설정 파일이 필요 없습니다. 별도 서버나 백그라운드 프로세스도 없습니다.

## 설치

요구 사항: GNOME Shell 51, GJS 1.90+, libsoup 3.4 이상, Node 22+(개발·빌드에만), zip/unzip.

```bash
git clone https://github.com/ijustsea/btcprice-gnome.git "$HOME/Projects/utility/btcprice-gnome"
npm --prefix "$HOME/Projects/utility/btcprice-gnome" ci --ignore-scripts
npm --prefix "$HOME/Projects/utility/btcprice-gnome" run pack
gnome-extensions install --force "$HOME/Projects/utility/btcprice-gnome/dist/btcprice-gnome@ijustsea.github.io.shell-extension.zip"
```

Wayland에서는 **GNOME 로그아웃 후 다시 로그인**한 다음 켭니다.

```bash
gnome-extensions enable btcprice-gnome@ijustsea.github.io
```

업데이트는 `git pull` 뒤 `run pack`과 `install --force`를 다시 실행하고 로그아웃·로그인하면 됩니다.

## 동작과 가벼움

- **5초 간격의 근거**: Coinbase 시세 응답은 최대 1초만 캐시되고(`max-age=1`), 2분 동안 1초마다 받아 보니 마지막 체결은 길어야 1.4초 전이었습니다. 5초 간격으로 읽으면 정수 달러 표시가 84% 바뀌었습니다(15초 간격은 96%). 초당 0.2회 요청으로, Coinbase 공개 API 한도(IP당 초당 10회)보다 훨씬 적습니다.
- **연결 재사용**: 확장 활성화 동안 하나의 Soup 세션에서 거래소별 HTTPS 연결을 재사용합니다. HTTP/1.1을 사용합니다. 테스트한 libsoup 3.8에서 HTTP/2 요청은 응답 헤더를 기다리는 중 취소가 지연돼 마감을 지키지 못했습니다.
- **정상 조회**: 한 번에 한 요청만 진행합니다. Binance에서 계속 받을 수 있으면 5초마다 표시하고, Coinbase는 자신의 대기 시간이 끝나면 다시 시도합니다.
- **실패와 서버 제한**: 거래소마다 연속 실패에 10초, 20초, 40초, 최대 60초의 로컬 지연을 적용합니다. 429·418·503의 유효한 `Retry-After`(초 또는 HTTP 날짜)는 더 길어도 존중합니다. 418에 헤더가 없거나 날짜형 헤더에 비교할 서버 `Date`가 없으면 최소 2분 대기합니다. 두 거래소 모두 대기 중이면 다음 조회 가능 시각까지 기다립니다. 수동 Refresh와 네트워크 복구는 로컬 지연을 건너뛸 수 있으며, 서버 제한은 잠금 해제 후에도 유지됩니다. 연결 복구 알림이 조회 중 왔다면, 해당 조회가 실패할 때 한 번 즉시 다시 시도합니다.
- **실패 로그**: 연속 실패는 거래소별로 첫 건만 로그에 남깁니다. Coinbase가 성공하면 이미 만료된 Binance의 로컬 실패 기록을 정리하므로, 다음 장애는 첫 실패부터 기록합니다. 아직 유효한 로컬 지연과 서버 제한은 그동안 유지됩니다.
- **멈추지 않는 조회**: 요청 하나는 DNS 조회부터 응답 본문까지 10초 안에 끝나야 합니다. 응답을 조금씩 흘려보내는 서버나 응답 없는 DNS 때문에 조회가 멈춰 있지 않습니다.
- **잠금과 복원**: GDM·logind를 쓰는 Fedora 같은 환경에서 GNOME이 `unlock-dialog` 모드로 전환해 확장을 비활성화하면 요청과 타이머도 정리됩니다. 다시 활성화하면 마지막 가격과 실패 표시를 함께 복원한 뒤 조회합니다. 잠기지 않은 상태에서는 입력이 없거나 전체 화면 창이 상단바를 가려도 계속 조회합니다.
- **가격 신선도**: Coinbase 체결 시각을 응답의 `Date`와 비교합니다. 응답 시계가 체결 시계보다 최대 3초 늦으면 그 차이를 0으로 처리한 뒤 캐시 `Age`와 본문 수신 시간을 더합니다. 오래된 체결은 메뉴에 표시하고, 시각을 검증할 정보가 부족하면 `신선도 미확인`으로 표시합니다. Binance는 확인한 `BTCUSDT` 가격과 로컬 수신 시각을 표시합니다. `~`는 실패·오래된 값·신선도를 확인할 수 없는 값에 붙습니다.
- **안정적인 상단바**: 조회 중에는 현재 표시를 유지합니다. 고정폭 숫자(`tnum`)를 사용해 같은 자릿수의 가격이 바뀔 때 주변 패널 항목이 밀리지 않게 합니다.
- **안전한 응답 처리**: 응답은 HTTPS로만 받고 리다이렉트는 따르지 않습니다(HTTP로 넘어가거나 다른 호스트로 가는 경우를 막음). 본문은 16KiB까지만 읽고, `price`가 1 이상의 소수 문자열일 때만 표시합니다. 그 밖의 응답은 실패로 처리합니다. 로그에 남기는 서버 문자열은 따옴표로 감싸 줄바꿈으로 로그를 꾸며낼 수 없습니다. 쿠키를 저장하지 않고 API 키나 계정 정보를 보내지 않습니다.

### 개발 PC 측정 기록

- Coinbase를 15초 간격으로 조회했을 때 조회당 프로세스 CPU 시간은 매번 TLS 연결을 만들면 11–12.5ms, 연결을 재사용하면 4.6–4.8ms였습니다. 같은 비교에서 응답 시간은 27–31ms와 11–12ms였습니다.
- 설치한 확장의 재사용 연결을 `ss`로 관측했을 때 TLS를 포함해 조회당 약 190B를 보내고 1.75KB를 받았습니다. 같은 크기로 5초 간격 조회를 계속하면 시간당 약 1.4MB입니다.
- 같은 31초 동안 실제 Coinbase를 1회 조회하거나 5초 간격으로 7회 조회하는 조건을 각각 3번 비교했습니다. CPU 시간 차이는 측정 오차 범위에 있었습니다. 관측된 가장 큰 차이를 추가 조회 횟수로 나누면 조회당 약 4ms 이하였고, 7회 조회는 한 연결을 재사용했습니다.

## TradingView와 값이 다를 때

TradingView의 `CRYPTO:BTCUSD`는 여러 거래소를 합친 지수라 Coinbase 가격과 몇 달러 다를 수 있습니다. 같은 기준으로 비교하려면 TradingView에서 `COINBASE:BTCUSD`를 보세요. 메뉴의 차트 링크가 이 심볼을 엽니다. TradingView는 공개 시세 API가 없고 약관상 자동 수집을 금지하므로 시세 출처로 쓰지 않습니다. Binance 대체값은 USDT 기준이라 USD와 약간 다를 수 있어 단위를 함께 표시합니다.

## 개발·검증

```bash
npm --prefix "$HOME/Projects/utility/btcprice-gnome" run check
npm --prefix "$HOME/Projects/utility/btcprice-gnome" run test:shell
```

- `check`: 가격 파싱·표시·간격 단위 테스트(Coinbase 체결 시각과 `Date`·`Age`로 본 신선도, 3초 시계 오차, Binance `BTCUSDT` 심볼 검사 포함), 확장 수명 주기 테스트(가격과 실패 표시 복원), 로컬 HTTP 서버를 쓰는 실제 GJS 통신 테스트(응답 형식, HTTP 오류, 16KiB 제한, 취소), Coinbase 우선·Binance 대체·거래소별 간격 늘림·서버 대기 유지·조회 중 복구 알림·잠금 해제 테스트, 실제 API처럼 HTTP/2를 제공하는 로컬 TLS 서버 테스트(자체 서명 인증서 거부, 429·418·503의 `Retry-After`, 오래된 체결과 본문 수신 시간, 잘못된 심볼, HTTP/1.1 연결이 조회 간격 뒤에도 재사용되는지, HTTPS→HTTP 리다이렉트 거부, 10초 마감), 결정적 ZIP 테스트를 실행합니다. TLS 테스트에는 `openssl`이 필요합니다(GJS 테스트 전체 약 14초).
- `test:shell`: 별도 D-Bus·설정의 헤드리스 GNOME Shell과 로컬 시세 서버로 상단바, 메뉴 카드, Refresh, 차트 버튼을 검사합니다. 확장을 비활성화했다 다시 켜서 실패 표시와 서버 대기 시간이 유지되는지도 확인합니다. `BTCPRICE_UI_CAPTURE=/경로/menu.png`를 주면 메뉴를 캡처합니다. 인터넷이 필요 없습니다. `BTCPRICE_TEST_MONITOR=1024x480`으로 작은 화면도 검사할 수 있습니다.

구조: `src/price.ts` 파싱·표시 규칙 → `src/client.ts` HTTP → `src/controller.ts` 조회 순서·간격 → `src/indicator.ts` 상단바 → `src/extension.ts` 수명 주기.

## 근거

- [Coinbase Exchange: Get product ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)
- [Coinbase Exchange: Rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)
- [Binance Spot API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)
- [TradingView 이용약관](https://www.tradingview.com/policies/)
