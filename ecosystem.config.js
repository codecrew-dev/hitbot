module.exports = {
  apps: [
    {
      name: 'Hitbot',
      cwd: '/home/ubuntu/Desktop/Tori/hitbot',
      script: 'npm',          // ??? ???? (npm)
      args: 'run dev',        // npm ?? ?? ??? (run dev)
      interpreter: 'none',    // npm? ??????? none ??
      instances: 1,
      autorestart: true,
      watch: false,           // ?? ?? ??? ?? (?? ? true)
      env: {
        NODE_ENV: 'development' // dev ?? ??
      }
    }
  ]
};
