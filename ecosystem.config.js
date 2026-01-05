module.exports = {
    apps: [{
        name: "nas100-bot",
        script: "./trading-bot.js",
        watch: false,
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "production",
        },
        error_file: "logs/err.log",
        out_file: "logs/out.log",
        time: true
    }]
};
