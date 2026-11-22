//! The engine's TEST CARD (E0b, E0c): four flat quadrants in pure colours — red, green, blue, white,
//! exact through any 8-bit path, sRGB or not, being 0 or 1 per channel — under a black band across the
//! top eighth with a magenta bar that moves one step per frame, so two captures prove a picture is LIVE.
//! A probe checks it from wherever the picture lands: the screen (an engine window) or a page (a shared
//! texture in Electron).

use crate::Gpu;

pub const CARD_WGSL: &str = r#"
struct Card { size: vec2<f32>, bar: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> card: Card;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = pos.xy / card.size;
    if (uv.y < 0.125) {
        // The live band: black, with a magenta bar 1/16 of the width wide.
        let x = fract(uv.x - card.bar);
        if (x < 0.0625) { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let right = uv.x >= 0.5;
    let low = uv.y >= 0.5625;           // the quadrants split the area under the band
    if (!right && !low) { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }   // red
    if (right && !low)  { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }   // green
    if (!right && low)  { return vec4<f32>(0.0, 0.0, 1.0, 1.0); }   // blue
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);                           // white
}
"#;

pub struct Card {
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

impl Card {
    pub fn new(d: &wgpu::Device, format: wgpu::TextureFormat) -> Card {
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("card"), source: wgpu::ShaderSource::Wgsl(CARD_WGSL.into()) });
        let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("card"),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let uniform = d.create_buffer(&wgpu::BufferDescriptor { label: Some("card"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("card"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
        });
        Card { pipeline, uniform, bind }
    }

    /// Frame `frame` of the card into `view` (w x h). Submit the returned buffer before the next call.
    pub fn encode(&self, gpu: &Gpu, view: &wgpu::TextureView, w: u32, h: u32, frame: u64) -> wgpu::CommandBuffer {
        let bar = (frame % 240) as f32 / 240.0;
        let mut u = [0u8; 16];
        u[0..4].copy_from_slice(&(w as f32).to_le_bytes());
        u[4..8].copy_from_slice(&(h as f32).to_le_bytes());
        u[8..12].copy_from_slice(&bar.to_le_bytes());
        gpu.queue.write_buffer(&self.uniform, 0, &u);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("card"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        enc.finish()
    }
}
