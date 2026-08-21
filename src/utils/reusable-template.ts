import { defineComponent, type Slot } from 'vue'

/**
 * 在同一个组件里把一段模板定义一次、多处复用，且**沿用定义处的作用域**——
 * 复用处不必把上百个局部函数与状态当 props 传出去。
 *
 * 用途是同一段步骤行既要平铺在列表里、又要出现在折叠行内部，
 * 拆成独立组件需要把整块渲染依赖全部外挂，得不偿失。
 *
 * 约束：定义必须在使用之前渲染（把 Define 放在模板靠前的位置）。
 */
export function createReusableTemplate<Props extends Record<string, unknown>>() {
  let captured: Slot<Props> | undefined

  const define = defineComponent({
    name: 'DefineTemplate',
    setup(_, { slots }) {
      return () => {
        captured = slots.default as Slot<Props> | undefined
        return null
      }
    },
  })

  const reuse = defineComponent({
    name: 'ReuseTemplate',
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () => captured?.(attrs as unknown as Props)
    },
  })

  return [define, reuse] as const
}
