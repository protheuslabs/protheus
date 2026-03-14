// SPDX-License-Identifier: Apache-2.0
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllocatorSnapshot {
    pub alloc_calls: usize,
    pub dealloc_calls: usize,
    pub bytes_requested: usize,
    pub bytes_released: usize,
    pub bytes_outstanding: usize,
}

pub struct Layer0CountingAllocator;

static ALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static DEALLOC_CALLS: AtomicUsize = AtomicUsize::new(0);
static BYTES_REQUESTED: AtomicUsize = AtomicUsize::new(0);
static BYTES_RELEASED: AtomicUsize = AtomicUsize::new(0);
static BYTES_OUTSTANDING: AtomicUsize = AtomicUsize::new(0);

impl Layer0CountingAllocator {
    pub fn snapshot() -> AllocatorSnapshot {
        AllocatorSnapshot {
            alloc_calls: ALLOC_CALLS.load(Ordering::Relaxed),
            dealloc_calls: DEALLOC_CALLS.load(Ordering::Relaxed),
            bytes_requested: BYTES_REQUESTED.load(Ordering::Relaxed),
            bytes_released: BYTES_RELEASED.load(Ordering::Relaxed),
            bytes_outstanding: BYTES_OUTSTANDING.load(Ordering::Relaxed),
        }
    }
}

unsafe impl GlobalAlloc for Layer0CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let size = layout.size();
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES_REQUESTED.fetch_add(size, Ordering::Relaxed);
        BYTES_OUTSTANDING.fetch_add(size, Ordering::Relaxed);
        // SAFETY: delegated to the platform allocator with the same layout.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let size = layout.size();
        DEALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES_RELEASED.fetch_add(size, Ordering::Relaxed);
        BYTES_OUTSTANDING.fetch_sub(size, Ordering::Relaxed);
        // SAFETY: delegated to the platform allocator with the same layout.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let size = layout.size();
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES_REQUESTED.fetch_add(size, Ordering::Relaxed);
        BYTES_OUTSTANDING.fetch_add(size, Ordering::Relaxed);
        // SAFETY: delegated to the platform allocator with the same layout.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old_size = layout.size();
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES_REQUESTED.fetch_add(new_size, Ordering::Relaxed);
        if new_size >= old_size {
            BYTES_OUTSTANDING.fetch_add(new_size - old_size, Ordering::Relaxed);
        } else {
            BYTES_RELEASED.fetch_add(old_size - new_size, Ordering::Relaxed);
            BYTES_OUTSTANDING.fetch_sub(old_size - new_size, Ordering::Relaxed);
        }
        // SAFETY: delegated to the platform allocator with the same layout.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}
