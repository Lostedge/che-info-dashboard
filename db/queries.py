"""
SQL 查询
"""

# 场桥作业统计：当日累计 + 当前时段
CY_COMMAND_STATS = """
    SELECT
        CY_MACH_NO,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.CY_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= TRUNC(SYSDATE)
      AND WORK_TIM <  :period_end
      AND CY_MACH_NO IS NOT NULL
    GROUP BY CY_MACH_NO
    ORDER BY CY_MACH_NO
"""

# TRUCK_STATS = """..."""
# DRIVER_STATS = """..."""