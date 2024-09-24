import { useMediaQuery } from "@mantine/hooks";

export default function useDisplaySize() {
    const isMobile = useMediaQuery(`(max-width: 767px)`);
    const isTablet = useMediaQuery(`(max-width: 1024px)`);

    return { isMobile: isMobile, isTablet: isTablet };
}