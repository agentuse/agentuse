const plugin = {
  'agent:complete': async (event) => {
    console.log(`JS plugin received event for agent: ${event.agent.name}`);
  }
};

export default plugin;