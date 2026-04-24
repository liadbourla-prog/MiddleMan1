import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean
  }
}
