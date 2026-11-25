# BTC Price GNOME

GNOME 상단바에 비트코인 가격을 5초마다 표시합니다.

- **Coinbase**(`BTC-USD`)가 기본 시세입니다. 상단바: `BTC $61,764`
- Coinbase가 응답하지 않을 때만 **Binance**(`BTCUSDT`)로 대신 표시합니다. 상단바: `BTC 61,770 USDT`. 다음 조회는 다시 Coinbase부터 시도합니다.
- 메뉴는 카드 하나입니다. 시세 출처(Coinbase/Binance), 센트까지의 정확한 가격, 기준 시각, **Refresh**(메뉴를 닫지 않고 바로 갱신), **TradingView chart ↗**(누를 때만 브라우저로 엽니다)가 있습니다.
- API 키·계정·설정 파일이 필요 없습니다. 별도 서버나 백그라운드 프로세스도 없습니다.

## 설치

요구 사항: GNOME Shell 51, GJS 1.90+, libsoup 3, Node 22+(개발·빌드에만), zip/unzip.

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
- **연결 재사용**: 확장이 켜져 있는 동안 HTTPS 연결 하나를 유지합니다. 이전 버전은 HTTP/2와 10초 소켓 시간 제한 때문에 쉬는 연결이 끊겨, 조회마다 TLS 연결을 새로 맺었습니다. 이 개발 PC에서 실제 Coinbase를 15초 간격으로 조회해 프로세스 CPU를 쟀습니다. 조회당 CPU는 매번 새로 연결할 때 11–12.5ms, 연결 하나를 재사용할 때 4.6–4.8ms였습니다. 조회 시간은 27–31ms에서 11–12ms로 줄었습니다. 설치된 확장을 `ss`로 보면 연결 하나로 조회마다 약 190B를 보내고 약 1.75KB를 받습니다(TLS 포함). 5초 간격이면 시간당 약 1.4MB입니다. 실제 Coinbase를 같은 31초 동안 1회와 7회(5초 간격) 조회해 CPU를 3번씩 비교한 결과, 차이는 측정 오차 안이었습니다(가장 큰 차이로 계산해도 조회당 약 4ms 이하). 7회 모두 연결 하나를 재사용했습니다. 요청은 HTTP/1.1로 보냅니다. libsoup 3.8에서 HTTP/2 요청은 응답 헤더를 기다리는 중에 취소해도 끝나지 않아, 아래의 10초 마감이 작동하지 않기 때문입니다.
- **요청 1개**: 조회마다 Coinbase에 요청 하나만 보냅니다. Binance는 Coinbase가 실패한 조회에서만 호출합니다.
- **실패 시 간격 늘림**: 두 곳 모두 실패하면 10초, 20초, 40초, 그다음부터 60초 간격으로 재시도하고, 성공하면 5초로 돌아옵니다. 실패 중에 인터넷 연결이 돌아왔다는 알림(`Gio.NetworkMonitor`의 연결 상태가 `FULL`)이 오면 기다리지 않고 바로 다시 조회합니다. 정상일 때는 이 알림을 무시합니다. 알림이 없어도 늦어도 1분 뒤에는 다시 조회합니다. 마지막 가격은 `~`와 함께 그대로 둡니다. 실패 원인은 출처마다 실패가 시작될 때 한 번만 GNOME 로그(`journalctl`)에 남깁니다(잠금 해제처럼 확장이 다시 켜지면 다시 한 번).
- **멈추지 않는 조회**: 요청 하나는 DNS 조회부터 응답 본문까지 10초 안에 끝나야 합니다. 응답을 조금씩 흘려보내는 서버나 응답 없는 DNS 때문에 조회가 멈춰 있지 않습니다.
- **화면이 켜져 있고 잠기지 않은 동안 조회**: 키보드·마우스 입력이 없어도 계속 갱신합니다. 가격은 보고만 있는 경우가 많기 때문입니다. 화면이 꺼지거나 잠기면 GNOME이 확장을 끄고(화면 보호가 `unlock-dialog` 세션 모드로 바꿈. GDM·logind를 쓰는 Fedora 같은 환경), 절전 중에는 타이머가 멈추므로 조회하지 않습니다. 전체 화면 창이 상단바를 가려도 잠기지 않았다면 계속 조회합니다. 잠금을 풀면 마지막 가격을 바로 보여주고(1분보다 오래됐으면 `~`), 곧바로 새로 조회합니다. 아직 네트워크가 연결되지 않아 조회가 실패해도 마지막 가격을 `~`와 함께 유지합니다.
- **흔들림 없는 상단바**: 조회 중 상태를 표시하지 않고 결과만 반영합니다. 숫자는 고정폭으로 표시합니다. GNOME 기본 글꼴은 이미 고정폭이며, 다른 글꼴을 위해 `tnum` 스타일을 둡니다. `~`는 마지막 조회가 두 곳 모두 실패했거나, 잠금 해제 직후 보여주는 가격이 1분보다 오래됐을 때만 붙습니다. 이때 메뉴의 가격도 흐리게 표시합니다.
- **안전한 응답 처리**: 응답은 HTTPS로만 받고 리다이렉트는 따르지 않습니다(HTTP로 넘어가거나 다른 호스트로 가는 경우를 막음). 본문은 16KiB까지만 읽고, `price`가 1 이상의 소수 문자열일 때만 표시합니다. 그 밖의 응답은 실패로 처리합니다. 로그에 남기는 서버 문자열은 따옴표로 감싸 줄바꿈으로 로그를 꾸며낼 수 없습니다. 쿠키를 저장하지 않고 API 키나 계정 정보를 보내지 않습니다.

## TradingView와 값이 다를 때

TradingView의 `CRYPTO:BTCUSD`는 여러 거래소를 합친 지수라 Coinbase 가격과 몇 달러 다를 수 있습니다. 같은 기준으로 비교하려면 TradingView에서 `COINBASE:BTCUSD`를 보세요. 메뉴의 차트 링크가 이 심볼을 엽니다. TradingView는 공개 시세 API가 없고 약관상 자동 수집을 금지하므로 시세 출처로 쓰지 않습니다. Binance 대체값은 USDT 기준이라 USD와 약간 다를 수 있어 단위를 함께 표시합니다.

## 개발·검증

```bash
npm --prefix "$HOME/Projects/utility/btcprice-gnome" run check
npm --prefix "$HOME/Projects/utility/btcprice-gnome" run test:shell
```

- `check`: 가격 파싱·표시·간격 단위 테스트, 확장 수명 주기 테스트, 로컬 HTTP 서버를 쓰는 실제 GJS 통신 테스트(응답 형식, HTTP 오류, 16KiB 제한, 취소), 실제 API처럼 HTTP/2를 제공하는 로컬 TLS 서버 테스트(HTTP/1.1 연결이 조회 간격 뒤에도 재사용되는지, HTTPS→HTTP 리다이렉트 거부, 10초 마감), Coinbase 우선·Binance 대체·간격 늘림·잠금 해제 테스트, 결정적 ZIP 테스트를 실행합니다. TLS 테스트에는 `openssl`이 필요합니다(약 10초).
- `test:shell`: 별도 D-Bus·설정의 헤드리스 GNOME Shell과 로컬 가짜 시세 서버로 실제 상단바 글자, 메뉴 카드(글자가 흐려지지 않는지, Refresh는 메뉴를 닫지 않고 차트 버튼은 닫는지)와 동작을 검사합니다. `BTCPRICE_UI_CAPTURE=/경로/menu.png`를 주면 메뉴를 캡처합니다. 인터넷이 필요 없습니다. `BTCPRICE_TEST_MONITOR=1024x480`으로 작은 화면도 검사할 수 있습니다.

구조: `src/price.ts` 파싱·표시 규칙 → `src/client.ts` HTTP → `src/controller.ts` 조회 순서·간격 → `src/indicator.ts` 상단바 → `src/extension.ts` 수명 주기.

## 근거

- [Coinbase Exchange: Get product ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)
- [Coinbase Exchange: Rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)
- [Binance Spot API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)
- [TradingView 이용약관](https://www.tradingview.com/policies/)
