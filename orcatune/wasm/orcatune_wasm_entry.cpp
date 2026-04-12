#include "../../../src/orcatune/OrcaTuneBungeeCore.h"

#include <cstdint>

extern "C"
{
    struct OrcaTuneHandle
    {
        OrcaTuneBungeeCore core;
    };

    OrcaTuneHandle* orcatune_create_processor (double sample_rate, int channels, int max_block_size)
    {
        auto* handle = new OrcaTuneHandle();
        if (!handle->core.prepare (sample_rate, channels, max_block_size))
        {
            delete handle;
            return nullptr;
        }
        return handle;
    }

    void orcatune_destroy_processor (OrcaTuneHandle* handle)
    {
        delete handle;
    }

    void orcatune_set_semitones (OrcaTuneHandle* handle, float semitones)
    {
        if (handle == nullptr)
            return;
        handle->core.setSemitones (semitones);
    }

    void orcatune_reset (OrcaTuneHandle* handle)
    {
        if (handle == nullptr)
            return;
        handle->core.reset();
    }

    int orcatune_process_interleaved (OrcaTuneHandle* handle, const float* input, float* output, int channels, int frames)
    {
        if (handle == nullptr)
            return 0;
        return handle->core.processInterleaved (input, output, channels, frames);
    }
}
