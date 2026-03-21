import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'nav',
  description: 'Minimalist coding agent with hashline-based editing',
  base: '/nav/',
  head: [
    ['meta', { property: 'og:title', content: 'nav' }],
    ['meta', { property: 'og:description', content: 'Edit code. Not files.' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-nav' },
      { text: 'Concepts', link: '/concepts/hashline-editing' },
      { text: 'Reference', link: '/reference/cli-reference' },
      {
        text: 'v0.5.1',
        items: [
          { text: 'Changelog', link: '/reference/changelog' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is nav?', link: '/guide/what-is-nav' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Usage',
          items: [
            { text: 'Commands', link: '/guide/commands' },
            { text: 'Skills', link: '/guide/skills' },
            { text: 'Plans & Tasks', link: '/guide/plans-and-tasks' },
            { text: 'Hooks', link: '/guide/hooks' },
            { text: 'Sandboxing', link: '/guide/sandboxing' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Core Concepts',
          items: [
            { text: 'Hashline Editing', link: '/concepts/hashline-editing' },
            { text: 'Tools', link: '/concepts/tools' },
            { text: 'Handover', link: '/concepts/handover' },
            { text: 'AGENTS.md', link: '/concepts/agents-md' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI Reference', link: '/reference/cli-reference' },
            { text: 'Changelog', link: '/reference/changelog' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sandst1/nav' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
