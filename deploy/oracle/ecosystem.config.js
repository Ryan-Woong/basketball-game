// PM2 설정 (systemd 대신 PM2를 쓰고 싶을 때). 사용법은 SETUP.md 참고.
// 게임 상태가 프로세스 메모리에 있으므로 반드시 instances: 1, fork 모드여야 한다.
// (cluster 모드나 instances > 1 로 바꾸면 두 플레이어가 서로 다른 프로세스에 붙어 방을 못 찾는다)
module.exports = {
    apps: [
        {
            name: 'basketball-game',
            script: 'server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
                HOST: '0.0.0.0',
            },
        },
    ],
};
