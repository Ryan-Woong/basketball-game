# Oracle Cloud Always Free VM 배포 (Render가 맞지 않을 때의 비상용)

> **먼저 확인:** Oracle은 가입 때 신용/체크카드 인증이 필수다(선불카드 불가). 업그레이드하지 않으면 청구되지 않는다고 안내되지만, "결제수단 없이"라는 목표와는 맞지 않는다. 카드 등록이 가능하고 허용될 때만 이 경로를 쓴다.
> 이 문서의 명령은 **실제 VM에서 실행해 보지 못했다.** Oracle 콘솔 화면과 이미지 기본 설정은 달라질 수 있으니 막히면 오류 메시지를 그대로 확인한다.

코드는 바꿀 필요가 없다. `server.js`가 `PORT`, `HOST` 환경변수로 동작하고 기본은 `0.0.0.0:3000`이다.
원칙: **VM 1대, Node 프로세스 1개** (게임 상태가 메모리에 있다).

---

## 1. 계정과 VM 만들기

1. https://www.oracle.com/cloud/free/ 에서 가입한다. 홈 리전은 가입 때 정해지고 바꿀 수 없다.
2. 콘솔 → Compute → Instances → Create instance.
3. 이미지: **Canonical Ubuntu 22.04 (또는 24.04)**.
4. 쉐이프: **Always Free-eligible** 라벨이 붙은 것만 선택한다. (AMD Micro 또는 Ampere A1. Ampere는 용량 부족 오류가 날 수 있고, 그러면 다른 가용성 도메인으로 바꾸거나 나중에 다시 시도한다.)
5. 네트워킹: 공용 서브넷 + **Public IPv4 주소 할당**.
6. SSH 키: 새로 만들어 개인키를 내려받는다. 보관 필수.

## 2. 포트 열기 (두 군데 모두 필요)

**(a) Oracle 네트워크 규칙** — 콘솔 → 인스턴스의 VCN → Security List(또는 NSG) → Ingress Rule 추가
- Source CIDR `0.0.0.0/0`, Protocol TCP, Destination Port `3000`

**(b) VM 안의 방화벽** — Oracle의 Ubuntu 이미지는 기본 iptables 규칙이 접속을 막는 경우가 있다.
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent   # 설치 중 저장 여부를 물으면 Yes
sudo netfilter-persistent save
```
(`ufw`를 켤 계획이면 먼저 SSH 22번 포트를 허용하고, 3000도 허용한다. 순서를 틀리면 SSH가 막힌다.)

## 3. Node.js 설치

```bash
ssh -i <개인키파일> ubuntu@<VM 공인 IP>
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v     # v20.x 확인
```

## 4. 코드 올리기와 의존성 설치

```bash
git clone https://github.com/<내아이디>/basketball-game.git
cd basketball-game
npm ci --omit=dev        # package-lock.json 이 있을 때. 없으면: npm install --omit=dev
PORT=3000 node server.js # 먼저 직접 실행해서 확인 (Ctrl+C 로 종료)
```
다른 기기 브라우저에서 `http://<VM 공인 IP>:3000/healthz` → `ok`가 나오면 포트까지 정상이다.

## 5. 계속 실행되게 하기 (둘 중 하나만)

### 방법 A — systemd (권장, 별도 설치 없음)
```bash
sudo cp deploy/oracle/basketball-game.service /etc/systemd/system/
# 파일을 열어 User, WorkingDirectory 경로가 실제와 맞는지 확인
sudo systemctl daemon-reload
sudo systemctl enable --now basketball-game
sudo systemctl status basketball-game
journalctl -u basketball-game -f        # 실시간 로그
```
VM이 재부팅되어도 자동으로 다시 시작되고, 프로세스가 죽으면 3초 뒤 다시 시작된다.

### 방법 B — PM2
```bash
sudo npm install -g pm2
pm2 start deploy/oracle/ecosystem.config.js
pm2 save
pm2 startup systemd      # 화면에 출력되는 sudo 명령을 그대로 한 번 더 실행해야 부팅 시 자동 시작이 된다
pm2 logs basketball-game
```
`instances: 1`, `fork` 모드를 바꾸지 않는다.

## 6. 접속과 테스트

- 게임 주소: `http://<VM 공인 IP>:3000` (도메인과 HTTPS가 없으므로 `http://`와 WebSocket `ws://`로 동작한다. 브라우저에 "안전하지 않음" 표시가 뜨는 것은 정상이다.)
- 두 사람이 서로 다른 네트워크에서 접속해 `DEPLOY.md`의 5장 절차대로 테스트한다.

## 7. 코드 업데이트

```bash
cd ~/basketball-game && git pull && npm ci --omit=dev
sudo systemctl restart basketball-game      # PM2라면: pm2 restart basketball-game
```
재시작하면 메모리의 방은 사라진다.

## 8. 알아둘 제한

- **유휴 회수:** Oracle은 7일 동안 사용률이 낮은 Always Free 인스턴스를 회수(중지)할 수 있다. 이 서버는 평소 거의 놀기 때문에 해당될 가능성이 높다. 중지되면 콘솔에서 다시 시작하면 되고, 시작 후 서비스는 자동 실행 설정으로 다시 올라온다.
- **공인 IP 변경:** 인스턴스를 삭제/재생성하면 IP가 바뀐다. 중지/시작 사이에 IP가 유지되는지는 설정에 따라 다르니 콘솔에서 확인한다.
- **인스턴스를 2대 이상으로 늘리지 않는다.** 방 상태가 메모리에 있어 두 플레이어가 다른 서버에 붙으면 방을 못 찾는다.
